# Browser performance baselines

These results are machine- and browser-labelled evidence, not universal speed
promises. Compare runs only on the same hardware, power state, browser build,
and fixture revision.

The commands below are for a source-repository checkout; the published npm
package includes these records for reference but does not ship the test harness
or licensed fixtures.

Commands:

```sh
npm run build
npm run benchmark
YUMCUT_VIDEO_ADS_PROFILE_MATRIX=1 npx playwright test test/browser/profile-matrix.spec.ts
YUMCUT_VIDEO_ADS_PROFILE_MATRIX=1 YUMCUT_VIDEO_ADS_FIVE_MINUTE=1 \
  npx playwright test test/browser/profile-matrix.spec.ts
```

The normal benchmark uses a real mixed silent-H.264/silent-VP9/JPEG/text plus
synthetic-Opus composition.
The 4K rows use a one-second 3840×2160 derived encode of the real Blender
fixture, exercising 4K decoder surfaces as well as output composition/encoding.
Its source detail is still the 320×180 licensed master, so it is not a
native-detail quality reference.
The five-minute profile writes through a `FileSystemFileHandle` backed by OPFS
and deletes the temporary output after verifying its size.

For same-machine regression checks, use the median of three runs. Investigate
wall-clock regressions above 15% or JavaScript-heap regressions above 20%.
The JS heap counter does not include codec, GPU, Blob, or browser storage memory.
