# Third-Party Notices

Lilt uses the dependencies below. Exact dependency versions and resolved transitive packages are recorded in `go.mod`, `go.sum` and `web/package-lock.json`. Runtime FFmpeg is provided by the NAS operating system rather than bundled with Lilt.

| Component | Use | License and source |
| --- | --- | --- |
| Go standard library | Server and build tooling | BSD-3-Clause; [Go](https://go.dev/LICENSE) |
| modernc.org/sqlite | In-process SQLite driver | BSD-3-Clause; [modernc.org/sqlite](https://gitlab.com/cznic/sqlite) |
| SQLite | Embedded database engine | Public domain; [SQLite](https://www.sqlite.org/copyright.html) |
| go-pinyin | Chinese pinyin search indexing | MIT; [mozillazg/go-pinyin](https://github.com/mozillazg/go-pinyin) |
| golang.org/x/image | Safe WebP artwork decoding | BSD-3-Clause; [Go image libraries](https://pkg.go.dev/golang.org/x/image) |
| React and React DOM | Browser interface | MIT; [React](https://github.com/facebook/react) |
| hash-wasm | Browser SHA-256 upload fingerprints | MIT; [hash-wasm](https://github.com/Daninet/hash-wasm) |
| lucide-react | Interface icons | ISC, with applicable Feather-derived notices; [Lucide](https://github.com/lucide-icons/lucide) |
| TypeScript | Build-time type checking | Apache-2.0; [TypeScript](https://github.com/microsoft/TypeScript) |
| Vite and its React plugin | Build-time frontend packaging | MIT; [Vite](https://github.com/vitejs/vite) |
| DM Sans | Browser interface typography | SIL Open Font License 1.1; [DM Sans](https://github.com/googlefonts/dm-fonts) |
| Fraunces | Display typography | SIL Open Font License 1.1; [Fraunces](https://github.com/undercasetype/Fraunces) |
| FFmpeg and FFprobe | Local audio probing and compatible playback | LGPL/GPL according to the installed distribution build; [FFmpeg licensing](https://ffmpeg.org/legal.html) |

Lilt's application branding is authored for this project. It does not embed third-party music, album covers or lyrics; library content is supplied by its owner. The notices below reproduce the licenses of the directly bundled application dependencies.

## Bundled Fonts

DM Sans and Fraunces are bundled with the frontend under `web/public/fonts/` and served from `/lilt/fonts/`; the application makes no external font requests. The complete SIL Open Font License 1.1 texts accompany both font files.

- DM Sans: Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts). The complete notice and license are in [DM-Sans-OFL.txt](../web/public/fonts/DM-Sans-OFL.txt), alongside `dm-sans.ttf`.
- Fraunces: Copyright 2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces). The complete notice and license are in [Fraunces-OFL.txt](../web/public/fonts/Fraunces-OFL.txt), alongside `fraunces.ttf`.

## MIT-Licensed Components

React and React DOM:

Copyright (c) Meta Platforms, Inc. and affiliates.

go-pinyin:

Copyright (c) 2016 mozillazg

hash-wasm:

Copyright (c) 2020 Dani Biró

Feather-derived portions of Lucide:

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Lucide ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2023 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2025.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## SQLite Driver BSD License

Copyright (c) 2017 The Sqlite Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
this list of conditions and the following disclaimer in the documentation
and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
may be used to endorse or promote products derived from this software without
specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## SHA-256 Implementation in hash-wasm

Copyright (c) 2010, Aleksey Kravchenko <rhash.admin@gmail.com>

Modified for hash-wasm by Dani Biró.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

## Go Image Library BSD License

Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

- Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
- Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
- Neither the name of Google LLC nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
