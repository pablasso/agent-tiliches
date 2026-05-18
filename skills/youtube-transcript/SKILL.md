---
name: youtube-transcript
description: Fetch transcripts from YouTube videos for summarization, analysis, and question-answering. Use when the user provides a YouTube URL or video ID and wants context from the video.
---
# YouTube Transcript

Fetch transcripts from YouTube videos.

## Setup

Run once before first use:

```bash
cd {baseDir}
npm install
```

## Usage

```bash
{baseDir}/transcript.js <video-id-or-url> [language]
```

Accepts video ID or full URL:

- `EBw7gsDPAYQ`
- `https://www.youtube.com/watch?v=EBw7gsDPAYQ`
- `https://youtu.be/EBw7gsDPAYQ`
- `https://www.youtube.com/shorts/EBw7gsDPAYQ`

Optional language examples:

```bash
{baseDir}/transcript.js https://youtu.be/EBw7gsDPAYQ en
{baseDir}/transcript.js https://youtu.be/EBw7gsDPAYQ es
```

## Output

Timestamped transcript entries:

```text
[0:00] All right. So, I got this UniFi Theta
[0:15] I took the camera out, painted it
[1:23] And here's the final result
```

For long videos, save the transcript to a file first, then read or search that file:

```bash
mkdir -p .pi/cache/youtube-transcript
{baseDir}/transcript.js <video-id-or-url> > .pi/cache/youtube-transcript/transcript.txt
```

## Notes

- Requires the video to have captions/transcripts available.
- Works with auto-generated and manual transcripts when YouTube exposes them.
- Uses `youtube-transcript-plus`, which relies on unofficial YouTube APIs and may break if YouTube changes internals.
