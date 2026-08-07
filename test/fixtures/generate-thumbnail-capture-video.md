# test/fixtures/thumbnail-capture-video.webm — provenance

Used by `test/result-thumbnail-crossorigin-capture-behavioral.test.js` (and
its `test/helpers/cross-origin-video-server.js` helper) as the "real video"
served across a fake cross-origin boundary.

**Why not the repo's existing `assets/interpreters/intro/sage-intro-reference.mp4`
(H.264/mp4, already used by other result.html tests)?** This sandbox's
Playwright-bundled headless Chromium build
(`/opt/pw-browsers/chromium`) has NO H.264 decoder —
`document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')`
returns `''` here, confirmed directly. Any `<video>` pointed at that mp4 in
this environment sits at `readyState: 0` / `error.code: 4`
(`MEDIA_ERR_SRC_NOT_SUPPORTED`) forever — real decode never happens, so a
canvas-capture test against it would either hang or silently prove nothing
(never reaching the actual crossOrigin/taint code path this fix is about).
The same Chromium build DOES support VP8/VP9 WebM
(`canPlayType('video/webm; codecs="vp8"')` → `'probably'`), so this fixture
is a small real VP8 WebM instead — genuinely decodes, so `readyState`,
`currentTime`, and canvas capture all reflect real browser behavior, not a
mock.

Regenerated with (no ffmpeg on PATH in this sandbox, but Playwright ships
one built just for its own screen-recording feature, at
`/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux` — it only has a narrow
mjpeg-decode / libvpx-encode / webm-mux pipeline, which is exactly enough
for this):

```bash
# 30 frames of a simple animated gradient (not a static/black image --
# real content the canvas capture can meaningfully assert against),
# via Pillow (python3 -c "from PIL import Image; ...").
mkdir -p /tmp/vidframes && cd /tmp/vidframes
python3 -c "
from PIL import Image
W,H = 320,180
for i in range(30):
    img = Image.new('RGB', (W,H))
    px = img.load()
    for y in range(H):
        for x in range(W):
            px[x,y] = ((x*255//W + i*8) % 256, (y*255//H + i*5) % 256, (i*20) % 256)
    img.save('frame_%03d.jpg' % i, quality=85)
"
cat frame_*.jpg | /opt/pw-browsers/ffmpeg-1011/ffmpeg-linux -y \
  -f image2pipe -vcodec mjpeg -framerate 10 -i pipe:0 \
  -c:v libvpx -pix_fmt yuv420p -b:v 400k \
  test/fixtures/thumbnail-capture-video.webm
```

~63KB, 3 seconds, 320x180, VP8/WebM, no audio.
