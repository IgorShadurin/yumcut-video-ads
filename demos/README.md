# YumCut Video Ads consumer demos

These are independent applications, not source-only snippets. Each installs the
root package through `"yumcut-video-ads": "file:../.."`, serves its own copy of
the licensed demo media, accepts a user video and music file, renders a real
composition, and previews/downloads the result.

| Demo | Stack | Start command |
| --- | --- | --- |
| [`vanilla`](./vanilla) | TypeScript + Vite, no UI framework | `npm --prefix demos/vanilla run dev` |
| [`react-vite`](./react-vite) | React 19 + Vite | `npm --prefix demos/react-vite run dev` |
| [`nextjs`](./nextjs) | Next.js App Router + React 19 | `npm --prefix demos/nextjs run dev` |

From a fresh repository checkout, install and build all three with:

```sh
npm install
npm run build:demos
```

Run the production-build browser qualification with:

```sh
npm run test:demos
```

That suite uploads the checked-in square video and synthetic music through each
app's real file controls, renders them over a bundled template, plays the output
in a `<video>` element, checks console/page errors, captures screenshots, and also
checks every UI at a 390×844 mobile viewport.

The demos make no analytics, font-CDN, or render-service requests. Licensing and
checksums for every copied media asset are documented in
[`../MEDIA_LICENSES.md`](../MEDIA_LICENSES.md) and verified by
`npm run verify:media`.
