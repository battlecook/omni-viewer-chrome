# Third-Party Notices

This project bundles third-party software and fonts in the `vendor/` directory.
Each component remains under its own license, reproduced or referenced below.
This file is provided to satisfy the attribution requirements of those
licenses.

---

## Bundled libraries (`vendor/`)

| Component | Files | License | Copyright / Source |
|-----------|-------|---------|--------------------|
| rhwp | `rhwp.js`, `rhwp_bg.wasm` | MIT | Copyright (c) 2025-2026 Edward Kim — https://github.com/edwardkim/rhwp |
| rhwp-studio | `rhwp-studio/**` | MIT | Copyright (c) 2025-2026 Edward Kim — https://github.com/edwardkim/rhwp |
| PDF.js | `pdf.min.mjs`, `pdf.worker.min.mjs` | Apache-2.0 | Copyright 2024 Mozilla Foundation — https://github.com/mozilla/pdf.js |
| SheetJS (xlsx) | `xlsx.full.min.js` | Apache-2.0 | Copyright (C) SheetJS LLC — https://github.com/SheetJS/sheetjs |
| docx-preview | `docx-preview.min.js` | Apache-2.0 | https://github.com/VolodymyrBaydalka/docxjs |
| mammoth.js | `mammoth.browser.min.js` | BSD-2-Clause | Copyright (c) 2013, Michael Williamson — https://github.com/mwilliamson/mammoth.js |
| wavesurfer.js | `wavesurfer/**` | BSD-3-Clause | Copyright (c) 2012-2023, katspaugh and contributors — https://github.com/katspaugh/wavesurfer.js |
| ag-psd | `ag-psd.min.js` | MIT | Copyright (c) 2016 Agamnentzar — https://github.com/Agamnentzar/ag-psd |
| pdf-lib | `pdf-lib.min.js` | MIT | Copyright (c) Andrew Dillon — https://github.com/Hopding/pdf-lib |
| js-yaml | `js-yaml.min.js` | MIT | Copyright (C) 2011-2015 by Vitaly Puzrin — https://github.com/nodeca/js-yaml |
| JSZip | `jszip.min.js` | MIT | Copyright (c) 2009-2016 Stuart Knightley and contributors — https://github.com/Stuk/jszip |
| hyparquet | `hyparquet/**` | MIT | Copyright (c) Hyperparam — https://github.com/hyparam/hyparquet |
| libarchive.js | `libarchive-worker-bundle.js`, `libarchive.wasm` | MIT | Copyright (c) 2018 Nika Begiashvili — https://github.com/nika-begiashvili/libarchivejs |
| audio_engine | `audio_engine.wasm`, `audio_engine_browser.js` | Public Domain / MIT | Bundles stb_vorbis (Sean T. Barrett) and dr_libs: dr_mp3/dr_flac/dr_wav (David Reid). See below. |

### audio_engine components

The audio decoder WASM bundles the following public-domain / MIT libraries:

- **stb_vorbis** — Sean T. Barrett. Dual-licensed: Public Domain (Unlicense)
  or MIT. https://github.com/nothings/stb
- **dr_libs (dr_mp3, dr_flac, dr_wav)** — David Reid. Dual-licensed: Public
  Domain (Unlicense) or MIT-0. https://github.com/mackron/dr_libs

---

## Bundled fonts (`vendor/rhwp-studio/fonts/`)

The following fonts are bundled for faithful HWP/HWPX document rendering. All
are under the SIL Open Font License 1.1 unless noted otherwise. The full OFL
text is reproduced at the end of this file.

| Font | License | Source / Foundry |
|------|---------|------------------|
| Noto Sans KR, Noto Serif KR | SIL OFL 1.1 | Google — https://fonts.google.com/noto |
| Source Han Serif K (subset) | SIL OFL 1.1 | Adobe — https://github.com/adobe-fonts/source-han-serif |
| Nanum Gothic, Nanum Myeongjo, Nanum Gothic Coding | SIL OFL 1.1 | Naver — https://hangeul.naver.com |
| D2Coding | SIL OFL 1.1 | Naver — https://github.com/naver/d2codingfont |
| Pretendard | SIL OFL 1.1 | Kil Hyung-jin — https://github.com/orioncactus/pretendard |
| Gowun Batang | SIL OFL 1.1 | Yanghee Ryu — https://github.com/yangheeryu/Gowun-Batang |
| Gowun Dodum | SIL OFL 1.1 | Yanghee Ryu — https://github.com/yangheeryu/Gowun-Dodum |
| Spoqa Han Sans | SIL OFL 1.1 | Spoqa — https://github.com/spoqa/spoqa-han-sans |
| Happiness Sans | SIL OFL 1.1 | https://kdm.kr (Happiness Sans) |
| Latin Modern Math | GUST Font License (LPPL-compatible) | GUST e-foundry — http://www.gust.org.pl/projects/e-foundry/lm-math |

> Note: The Hancom "Hamchorom" fonts (HANBatang, HCRDotum) that ship with the
> upstream rhwp-studio build have been **removed** from this distribution
> because their license restricts modification and commercial redistribution.
> HWP documents that request those fonts fall back to the bundled open fonts.

---

## Full license texts

### MIT License

```
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
```

### BSD 2-Clause License (mammoth.js — Copyright (c) 2013, Michael Williamson)

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD 3-Clause License (wavesurfer.js — Copyright (c) 2012-2023, katspaugh and contributors)

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Apache License 2.0 (PDF.js, SheetJS, docx-preview)

These components are licensed under the Apache License, Version 2.0. A full
copy of the license is distributed with this project and release package at
`THIRD-PARTY-LICENSES/Apache-2.0.txt`.

The reviewed upstream distributions do not include separate `NOTICE` files.
Their applicable attribution notices are retained in the bundled files and
summarized here:

- PDF.js: Copyright 2024 Mozilla Foundation.
- SheetJS: Copyright (C) 2013-present SheetJS LLC.
- docx-preview: Copyright Volodymyr Baydalka.

The original license headers remain in `vendor/pdf.min.mjs`,
`vendor/pdf.worker.min.mjs`, `vendor/xlsx.full.min.js`, and
`vendor/docx-preview.min.js`.

### SIL Open Font License, Version 1.1 (bundled fonts)

```
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is available with a FAQ at: https://openfontlicense.org

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to any
document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical writer or
other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a
copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or in
the appropriate machine-readable metadata fields within text or binary
files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright
Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under
any other license. The requirement for fonts to remain under this license
does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not
met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.
```
