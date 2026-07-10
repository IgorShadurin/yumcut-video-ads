# Media fixtures

The video and poster files in `media/` contain short, recompressed excerpts from
**Big Buck Bunny** by the Blender Foundation. The film is licensed under
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).

- Original: https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4
- Project and credits: https://peach.blender.org/
- Attribution: `(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org`

The excerpts are included solely as compact, redistributable integration fixtures.
They are cropped, resized, recompressed, and stripped of audio. The separate
`yumcut-demo-music.ogg` file is an original synthetic three-tone test bed generated
by our reproducible fixture script; it contains no Big Buck Bunny soundtrack.
Run `scripts/download-test-media.sh` to reproduce them from the official source.

| File | SHA-256 |
| --- | --- |
| `bunny-template.mp4` | `a6697679a63f593ca1154f9537172691cd3fc56f7312abeb38cce8449a7e3d86` |
| `bunny-4k.mp4` | `c347017a5c7a708412a07442407333aa4aa6ecc9ef9194a930a9110607eed008` |
| `bunny-square.webm` | `69eddd706533efc84cdc1a88945a48ab652a6968cd717e55d25323f35cdaaaeb` |
| `yumcut-demo-music.ogg` | `d852eba0a9d86bae590a99d6cd6b155167dff5c26e4ad93d704999e840c9ce9f` |
| `bunny-poster.jpg` | `cdf2ab2ec5de781084c112ec8a4c1ec7316bc65f32c98a7eb96d642fec884864` |

`bunny-4k.mp4` is a one-second 3840×2160 derived encode of the licensed
excerpt. Its detail originates from the 320×180 master; it exists to exercise
real 4K decode surfaces and memory flow, not to serve as a native-4K quality
reference.
