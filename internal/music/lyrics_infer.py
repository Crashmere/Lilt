"""Offline SOFA inference adapter. Emit only bounded NDJSON on stdout."""

import contextlib
import copy
import json
import math
import pathlib
import re
import subprocess
import sys
import tempfile
import traceback


def emit(**event):
    print(json.dumps(event, ensure_ascii=False, allow_nan=False), flush=True)


SUNG_UNIT = re.compile(r"[\u3400-\u9fff]|['\u2019]?[A-Za-z]+(?:['\u2019][A-Za-z]+)*")


def read_dictionary(path):
    with path.open(encoding="utf-8") as source:
        return {word: phones.split() for word, phones in (line.strip().split("\t", 1) for line in source if line.strip())}


def line_units(line, dictionaries, pinyin):
    text = line["text"]
    matches = list(SUNG_UNIT.finditer(text))
    remaining = SUNG_UNIT.sub("", text)
    if any(character.isalnum() for character in remaining):
        raise ValueError("模型支持中文和英语，数字请写出演唱读法，其他语言请使用人工校准")
    if not matches:
        raise ValueError("选段包含没有演唱文字的行，请取消选择该行")
    override = line.get("pronunciation", "").split()
    if override and len(override) != len(matches):
        raise ValueError("发音校正需对应每个汉字和英语单词，以空格分隔；英语音素用 / 连接")
    syllables = pinyin(text) if any("\u3400" <= match[0] <= "\u9fff" for match in matches) else []
    units = []
    for index, match in enumerate(matches):
        language = "zh" if "\u3400" <= match[0] <= "\u9fff" else "en"
        if language not in dictionaries:
            raise ValueError("英语模型尚未安装，请先使用人工校准" if language == "en" else "中文模型尚未安装，请先使用人工校准")
        if override:
            pronunciation = override[index].lower().replace("\u2019", "'")
        elif language == "zh":
            pronunciation = syllables[match.start()]
        else:
            pronunciation = match[0].lower().replace("\u2019", "'")
        phones = [phone for phone in pronunciation.split("/") if phone] if language == "en" and "/" in pronunciation else dictionaries[language].get(pronunciation)
        if not phones:
            if language == "en":
                raise ValueError(f"英语词 {match[0][:48]} 不在词典中，请在发音校正中填写近音英语词或 / 连接的 ARPAbet 音素")
            raise ValueError("部分汉字发音不在模型词典中，请校正拼音或使用人工打点")
        left = 0 if index == 0 else match.start()
        right = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        units.append((language, phones, text[left:right]))
    return units


def phoneme_path(section, units, mixed):
    phones, words, mappings, owners, pieces = ["SP"], [], [-1], [], []
    for line in section:
        for language, pronunciation, piece in units[line["id"]]:
            index = len(words)
            words.append(str(index))
            phones.extend(f"{language}:{phone}" if mixed else phone for phone in pronunciation)
            mappings.extend([index] * len(pronunciation))
            phones.append("SP")
            mappings.append(-1)
            owners.append(line["id"])
            pieces.append(piece)
        mappings[-1] = -2
    return phones, words, mappings, owners, pieces


def bilingual_forward(models, phones, torch):
    # Normalize each language expert before mixing; raw checkpoint logits are not comparable.
    vocabulary = {phone: index for index, phone in enumerate(dict.fromkeys(phones))}
    vocabulary["<vocab_size>"] = len(vocabulary)
    selections = {}
    for language, model in models.items():
        names = [phone for phone in vocabulary if phone.startswith(language + ":")]
        selections[language] = ([0] + [model.vocab[phone.split(":", 1)[1]] for phone in names], [0] + [vocabulary[phone] for phone in names])

    def forward(features):
        probabilities = features.new_zeros((*features.shape[:2], vocabulary["<vocab_size>"]), dtype=torch.float32)
        edge_probabilities = []
        for language, model in models.items():
            frames, edges, _ = model.forward(features)
            native, joint = selections[language]
            probabilities[:, :, joint] += torch.softmax(frames[:, :, native].float(), dim=-1) * 0.5
            edge_probabilities.append(torch.sigmoid(edges.float()))
        logits = probabilities.clamp_min(1e-9).log()
        edges = torch.stack(edge_probabilities).mean(0).clamp(1e-6, 1 - 1e-6)
        return logits, torch.logit(edges), logits

    return vocabulary, forward


def run(request):
    root = pathlib.Path(request["root"])
    job = request["job"]
    sys.path.insert(0, str(root / "SOFA"))
    emit(kind="progress", phase="加载歌声模型", progress=0.05)
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from pypinyin import lazy_pinyin, Style
        from modules.task.forced_alignment import LitForcedAlignmentTask

        torch.set_num_threads(2)
        dictionaries = {}
        for language, path in {"zh": root / "SOFA" / "dictionary" / "opencpop-extension.txt", "en": root / "model" / "english-dictionary.txt"}.items():
            if path.is_file():
                dictionaries[language] = read_dictionary(path)
        units = {line["id"]: line_units(line, dictionaries, lambda text: lazy_pinyin(text, style=Style.NORMAL, strict=False, errors=lambda value: list(value))) for line in job["lines"]}
        languages = {unit[0] for line in units.values() for unit in line}
        device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cuda" and torch.cuda.mem_get_info()[0] < (3 if len(languages) > 1 else 2) * 1024**3:
            raise ValueError("显存正被其他任务使用，请稍后重试")
        models = {}
        for language in sorted(languages):
            path = root / "model" / ("english.ckpt" if language == "en" else "model.ckpt")
            if not path.is_file():
                raise ValueError("英语模型尚未安装，请先使用人工校准" if language == "en" else "中文模型尚未安装，请先使用人工校准")
            model = LitForcedAlignmentTask.load_from_checkpoint(str(path), map_location="cpu").eval().to(device)
            model.set_inference_mode("force")
            model.on_predict_start()
            for line in units.values():
                for spoken_language, phones, _ in line:
                    if spoken_language == language and any(phone not in model.vocab or model.vocab[phone] == 0 for phone in phones):
                        raise ValueError("发音含有模型不支持的音素，请使用无重音标号的 ARPAbet 音素或校正拼音")
            models[language] = model
        model = next(iter(models.values()))
        if any(other.melspec_config != model.melspec_config for other in models.values()):
            raise ValueError("中英模型配置不兼容，请分别校准中文和英语选段")

    # Keep neural windows bounded while retaining the complete monotonic alignment path.
    frame_rate = model.melspec_config["sample_rate"] * model.melspec_config["scale_factor"] / model.melspec_config["hop_length"]
    window, overlap = int(frame_rate * 24), int(frame_rate * 3)

    def bounded_forward(features):
        if features.shape[1] <= window:
            return original_forward(features)
        outputs = [[], [], []]
        length = features.shape[1]
        for start in range(0, length, window):
            left, right = max(0, start - overlap), min(length, start + window + overlap)
            chunk = original_forward(features[:, left:right, :])
            for index, value in enumerate(chunk):
                outputs[index].append(value[:, start - left:min(start + window, length) - left].cpu())
        return tuple(torch.cat(parts, dim=1).to(device) for parts in outputs)

    lines = job["lines"]
    # Locked line starts split the search path and retain their exact manual times.
    boundaries = [0] + [i for i, line in enumerate(lines) if i > 0 and line["locked"]] + [len(lines)]
    results = []
    with tempfile.TemporaryDirectory(prefix=".lyrics-model-" + job["id"] + "-", dir=pathlib.Path(request["audio"]).parent) as stage:
        for part in range(len(boundaries) - 1):
            first, last = boundaries[part:part + 2]
            section = lines[first:last]
            start = section[0]["time"] if section[0]["locked"] else job["start"]
            end = lines[last]["time"] if last < len(lines) else job["end"]
            if end <= start:
                raise ValueError("锚点范围无效，请调整锁定时间")
            section_languages = {unit[0] for line in section for unit in units[line["id"]]}
            mixed = len(section_languages) > 1
            ph_seq, word_seq, mappings, owners, pieces = phoneme_path(section, units, mixed)
            model = models[sorted(section_languages)[0]]
            native_vocab, native_forward = model.vocab, model.forward
            if mixed:
                # Share the feature extractor without replacing either expert's native vocabulary/forward.
                decoder = copy.copy(model)
                decoder.vocab, original_forward = bilingual_forward(models, ph_seq, torch)
            else:
                decoder, original_forward = model, native_forward
            decoder.forward = bounded_forward
            frames = int((end - start) / 1000 * frame_rate)
            if frames * len(ph_seq) > 60_000_000:
                raise ValueError("整段过长，请锁定几个已确认的歌词时间后重试")
            path = pathlib.Path(stage) / "section.wav"
            emit(kind="progress", phase="读取选段", progress=0.12 + 0.8 * part / (len(boundaries) - 1))
            subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe", "-ss", str(start / 1000), "-i", request["audio"], "-t", str((end - start) / 1000), "-vn", "-ac", "1", "-ar", str(model.melspec_config["sample_rate"]), "-y", str(path)], check=True, timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            emit(kind="progress", phase="歌声对齐 · " + ("GPU" if device == "cuda" else "CPU"), progress=0.15 + 0.8 * part / (len(boundaries) - 1))
            with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
                prediction = decoder.predict_step((path, ph_seq, word_seq, mappings), 0)
            model.vocab, model.forward = native_vocab, native_forward
            _, _, confidence, _, _, predicted_words, intervals = prediction
            if not math.isfinite(float(confidence)):
                raise ValueError("未找到可靠的歌声位置，请缩小范围或增加锚点")
            intervals = [interval for word, interval in zip(predicted_words, intervals) if word != "BND"]
            if len(intervals) != len(owners):
                raise ValueError("歌词与演唱未完整匹配，请检查歌词或缩小范围")
            grouped = {line["id"]: [] for line in section}
            for owner, text, interval in zip(owners, pieces, intervals):
                word_start = max(start, min(end, start + float(interval[0]) * 1000))
                word_end = max(word_start, min(end, start + float(interval[1]) * 1000))
                grouped[owner].append({"text": text, "start": round(word_start), "end": round(word_end)})
            for line in section:
                words = grouped[line["id"]]
                timing = line["time"] if line["locked"] else words[0]["start"]
                warning = "建议复核" if float(confidence) < 0.65 else ""
                if mixed:
                    warning = "中英混合候选，请试听复核"
                if any(word["end"] - word["start"] < 30 for word in words):
                    warning = "部分字词时间过短，请试听复核"
                results.append({"id": line["id"], "time": timing, "words": words, "confidence": float(confidence), "warning": warning})
    emit(kind="result", results=results)


if __name__ == "__main__":
    try:
        run(json.load(sys.stdin))
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        message = str(error) if isinstance(error, ValueError) else "模型处理失败，请缩小校准范围后重试"
        emit(kind="error", error=message)
        sys.exit(1)
