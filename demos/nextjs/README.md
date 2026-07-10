# YumCut Video Ads · Next.js demo

A production-buildable Next.js App Router consumer. The browser-only studio
lets you select any bundled video template, add a local video and music track,
choose landscape, portrait, or square output, analyze support, render, cancel,
preview, and download the result.

The app installs the library from the repository root with:

```json
"yumcut-video-ads": "file:../.."
```

Run it from this directory:

```sh
npm install
npm run dev
```

Then open `http://localhost:3000`. Browser APIs are only initialized by the
`use client` studio component. The pre-development and pre-build hooks copy the
packaged worker into `public/vendor`, which also makes the setup explicit for
strict content-security-policy deployments.

The included demo media is CC BY 3.0. See
[`public/media/README.md`](public/media/README.md) for attribution.
