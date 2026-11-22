"""Offline SOFA inference adapter. Emit only bounded NDJSON on stdout."""

import contextlib
import json
import math
import os
import pathlib
import subprocess
import sys
import tempfile
import traceback


def emit(**event):
    print(json.dumps(event, ensure_ascii=False, allow_nan=False), flush=True)


def run(request):
    root = pathlib.Path(request["root"])
    job = request["job"]
    sys.path.insert(0, str(root / "SOFA"))
    emit(kind="progress", phase="加载歌声模型", progress=0.05)
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        import numpy as np
        from pypinyin import lazy_pinyin, Style
        from modules.g2p.dictionary_g2p import DictionaryG2P
        from modules.task.forced_alignment import LitForcedAlignmentTask

        torch.set_num_threads(2)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cuda" and torch.cuda.mem_get_info()[0] < 2 * 1024**3:
            raise ValueError("显存正被其他任务使用，请稍后重试")
        model = LitForcedAlignmentTask.load_from_checkpoint(str(root / "model" / "model.ckpt"), map_location="cpu").eval().to(device)
        model.set_inference_mode("force")
        model.on_predict_start()
        dictionary = DictionaryG2P(dictionary=str(root / "SOFA" / "dictionary" / "opencpop-extension.txt"))

    # Keep neural windows bounded while retaining the complete monotonic alignment path.
    original_forward = model.forward
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

    model.forward = bounded_forward
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
            tokens, owners, pieces = [], [], []
            for line in section:
                text = line["text"]
                syllables = lazy_pinyin(text, style=Style.NORMAL, strict=False, errors=lambda value: list(value))
                override = line.get("pronunciation", "").split()
                if override and len(override) != sum("\u3400" <= character <= "\u9fff" for character in text):
                    raise ValueError("校正拼音的数量应与本行汉字数量一致")
                positions = []
                for index, character in enumerate(text):
                    if "\u3400" <= character <= "\u9fff":
                        syllable = override[len(positions)] if override else syllables[index]
                        if syllable not in dictionary.dictionary:
                            raise ValueError("部分汉字发音不在模型词典中，请对该句使用人工打点")
                        tokens.append(syllable)
                        owners.append(line["id"])
                        positions.append(index)
                    elif character.isalnum():
                        raise ValueError("当前模型支持中文汉字，数字和外语请改用人工校准或缩小选段")
                if not positions:
                    raise ValueError("选段包含没有演唱文字的行，请取消选择该行")
                for index, position in enumerate(positions):
                    left = 0 if index == 0 else position
                    right = positions[index + 1] if index + 1 < len(positions) else len(text)
                    pieces.append(text[left:right])
                tokens.append("SP")
            ph_seq, word_seq, mappings = dictionary(" ".join(tokens))
            frames = int((end - start) / 1000 * frame_rate)
            if frames * len(ph_seq) > 60_000_000:
                raise ValueError("整段过长，请锁定几个已确认的歌词时间后重试")
            path = pathlib.Path(stage) / "section.wav"
            emit(kind="progress", phase="读取选段", progress=0.12 + 0.8 * part / (len(boundaries) - 1))
            subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe", "-ss", str(start / 1000), "-i", request["audio"], "-t", str((end - start) / 1000), "-vn", "-ac", "1", "-ar", str(model.melspec_config["sample_rate"]), "-y", str(path)], check=True, timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            emit(kind="progress", phase="歌声对齐 · " + ("GPU" if device == "cuda" else "CPU"), progress=0.15 + 0.8 * part / (len(boundaries) - 1))
            with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
                prediction = model.predict_step((path, ph_seq, word_seq, mappings), 0)
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
                if any(word["end"] - word["start"] < 30 for word in words):
                    warning = "部分字词时间过短，请试听复核"
                results.append({"id": line["id"], "time": timing, "words": words, "confidence": float(confidence), "warning": warning})
    emit(kind="result", results=results)


try:
    run(json.load(sys.stdin))
except Exception as error:
    traceback.print_exc(file=sys.stderr)
    message = str(error) if isinstance(error, ValueError) else "模型处理失败，请缩小校准范围后重试"
    emit(kind="error", error=message)
    sys.exit(1)
