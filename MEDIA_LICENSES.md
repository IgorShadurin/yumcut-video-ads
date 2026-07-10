# Demo media licenses

YumCut Video Ads ships no demo media in its npm package. The GitHub repository
contains compact media under `test/fixtures/media/` and copied into the demo
applications so every example can run offline.

## Big Buck Bunny derivatives

`bunny-template.mp4`, `bunny-square.webm`, `bunny-4k.mp4`, and
`bunny-poster.jpg` are cropped, resized, or recompressed excerpts from **Big Buck
Bunny** by the Blender Foundation. Audio has been removed from the video
derivatives.

- Original work: Big Buck Bunny
- Creator: Blender Foundation
- Source: https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4
- Project: https://peach.blender.org/
- License: Creative Commons Attribution 3.0 Unported
- License text: https://creativecommons.org/licenses/by/3.0/
- Requested credit: `(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org`
- Changes: short excerpts were cropped, resized, stripped of audio, and
  recompressed for browser integration tests and demos.

The CC BY 3.0 license permits sharing and adaptation, including commercially,
provided appropriate credit, a license link, and an indication of changes are
kept. The attribution above accompanies every copy in this repository.

## Generated audio

`yumcut-demo-music.ogg` is generated locally from three synthetic sine waves by
`scripts/download-test-media.sh`. It does not contain the Big Buck Bunny score
or another third-party recording and is provided under the repository's MIT
license.

## Reproducibility

`test/fixtures/manifest.json` pins the source and derived SHA-256 checksums.
Run `scripts/download-test-media.sh` to download the pinned official source and
rebuild every fixture.
