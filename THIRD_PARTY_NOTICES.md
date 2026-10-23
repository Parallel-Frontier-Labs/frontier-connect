# Third-party notices

The built task card (`dist/task-card.html`) loads the font files listed below as separate files
served next to it (`dist/static/`, with `OFL-1.1.<hash>.txt` beside them) instead of embedding them.
They are not covered by this repository's Apache-2.0 license; each is licensed under the SIL Open
Font License, Version 1.1. The license text, with both copyright lines, is in
[LICENSES/OFL-1.1.txt](LICENSES/OFL-1.1.txt); the build also keeps it in full in a comment in the
card.

## Public Sans

- Files: Public Sans 400, 600 and 700, latin subset (woff2), from the `@fontsource/public-sans`
  package, version 5.3.0.
- Copyright 2015 The Public Sans Project Authors (https://github.com/uswds/public-sans)

## IBM Plex Mono

- Files: IBM Plex Mono 400, latin subset (woff2), from the `@fontsource/ibm-plex-mono` package,
  version 5.3.0.
- Copyright 2017 IBM Corp. All rights reserved.

## SIL Open Font License, Version 1.1

The full license text is in [LICENSES/OFL-1.1.txt](LICENSES/OFL-1.1.txt). Every built
`dist/task-card.html` carries the same text in a comment next to the embedded fonts. The fonts are
used unmodified (the latin subsets published by @fontsource) and are not sold on their own.

## File viewers (loaded on demand, not part of the card file)

The spreadsheet, PDF and Word viewers are built as separate hashed files in `dist/static/`
(`viewer-sheet`, `viewer-pdf`, `viewer-docx`) and loaded by the card only when a file is previewed.
Each bundles the library below, unmodified, under its own license; the license text is in the
package's `LICENSE` file.

- SheetJS Community Edition 0.20.3 (`xlsx`), Apache-2.0.
  Copyright (C) 2012-present SheetJS LLC
- PDF.js (`pdfjs-dist` 4.10.38), Apache-2.0.
  Copyright 2024 Mozilla Foundation
  Its worker inlines an Emscripten build of OpenJPEG (JPEG 2000 decoding):
  - OpenJPEG, BSD-2-Clause. Copyright (c) 2002-2014, Universite catholique de Louvain (UCL), Belgium,
    and the other OpenJPEG authors named in [LICENSES/OpenJPEG-BSD-2-Clause.txt](LICENSES/OpenJPEG-BSD-2-Clause.txt)
  - Emscripten runtime glue in that build, MIT. Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.
- mammoth 1.13.0, BSD-2-Clause.
  Copyright (c) 2013, Michael Williamson
  Its browser build carries these modules, each also named with its license text in the banner of
  `viewer-docx`:
  - @xmldom/xmldom 0.8.6, MIT. Copyright 2019 - present Christopher J. Brody and other contributors; Copyright 2012 - 2017 @jindw and other contributors
  - base64-js 1.5.1, MIT. Copyright (c) 2014 Jameson Little
  - buffer 4.9.1, MIT. Copyright (c) Feross Aboukhadijeh, and other contributors.
  - dingbat-to-unicode 1.0.2, BSD-2-Clause. Copyright (c) 2021, Michael Williamson
  - ieee754 1.1.8, BSD-3-Clause. Copyright (c) 2008, Fair Oaks Labs, Inc.
  - isarray 1.0.0, MIT. Copyright (c) 2013 Julian Gruber
  - jszip 3.7.1, MIT (chosen from MIT OR GPL-3.0-or-later). Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, Antonio Afonso
  - pako 1.0.11 (inside jszip), MIT AND Zlib. Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn; zlib: Copyright (C) 1995-2013 Jean-loup Gailly and Mark Adler
  - lop 0.4.2, BSD-2-Clause. Copyright (c) 2013, Michael Williamson
  - option 0.2.4, BSD-2-Clause. Copyright (c) 2013, Michael Williamson
  - process 0.11.9, MIT. Copyright (c) 2013 Roman Shtylman
  - underscore 1.13.1, MIT. Copyright (c) 2009-2021 Jeremy Ashkenas, Julian Gonggrijp, and DocumentCloud and Investigative Reporters & Editors
  - xmlbuilder 10.0.0, MIT. Copyright (c) 2013 Ozgur Ozcitak

The SheetJS bundle contains no other third-party component. Every viewer file starts with
a notice banner listing its components and the license texts (MIT, BSD-2-Clause, BSD-3-Clause, Zlib
and Apache-2.0 as needed); the texts are kept in [LICENSES/](LICENSES/) and the packages' own
`LICENSE` files.
