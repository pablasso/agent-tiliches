---
name: youtube-transcript
description: Fetch transcripts from YouTube videos for summarization, analysis, and question-answering. Use when the user provides a YouTube URL or video ID and wants context from the video.
---
# YouTube Transcript

Fetch transcripts from YouTube videos and, by default, summarize them after the transcript is created.

## Default workflow

When a user provides a YouTube URL or video ID:

1. Fetch the transcript with `transcript.js`.
2. For medium or long videos, save the transcript to `.pi/cache/youtube-transcript/<video-id>.txt` before reading or summarizing it.
3. Tell the user where the transcript was saved, if applicable.
4. Unless the user explicitly asks for "transcript only" or "no summary", provide a summary after fetching the transcript.
5. Do not paste the full transcript unless the user asks for it.

## Summary expectations

Make the summary useful on its own, not just a short abstract. Err on the side of coverage rather than extreme brevity.

A good summary should:

- Preserve the video's structure when possible, including sections, acts, chapters, or major topic shifts.
- Cover all major arguments, examples, evidence, caveats, conclusions, and recommendations.
- Include important names, numbers, timelines, technical details, and practical takeaways when they matter.
- Avoid skipping important points just to be brief.
- Distinguish the speaker's claims or opinions from external facts when relevant.
- Use clear headings and bullets for longer videos.

For longer videos, prefer this shape:

1. `High-level summary` — a short overview of the main point.
2. `Detailed summary` — sectioned bullets that cover the important details.
3. `Key takeaways` — the most useful conclusions or actions.

Only add `My thoughts`, critique, or opinion when the user asks for analysis, thoughts, or a personal take.

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
