/**
 * YouTube AI Chat Assistant tools.
 * Tool names must match exactly for grading: generateImage, plot_metric_vs_time, play_video, compute_stats_json
 */

export const YOUTUBE_TOOL_DECLARATIONS = [
  {
    name: 'generateImage',
    description:
      'Generate an image from a text prompt. Optionally use an anchor/reference image that the user has dragged in. ' +
      'Use when the user asks to create, generate, or make an image. Returns a URL to the generated image.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: {
          type: 'STRING',
          description: 'Detailed text description of the image to generate (style, subject, colors, composition).',
        },
        use_anchor: {
          type: 'BOOLEAN',
          description: 'Whether to use the anchor image the user provided as reference (true if user attached an image).',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'plot_metric_vs_time',
    description:
      'Plot any numeric field (view_count, like_count, comment_count, duration_seconds, etc.) vs time for channel videos. ' +
      'Use when the user asks to plot, chart, or visualize a metric over time. Requires YouTube channel JSON to be loaded.',
    parameters: {
      type: 'OBJECT',
      properties: {
        metric_field: {
          type: 'STRING',
          description: 'Exact field name from the JSON (e.g. view_count, like_count, comment_count). Use published_at for time axis.',
        },
      },
      required: ['metric_field'],
    },
  },
  {
    name: 'play_video',
    description:
      'REQUIRED when user asks to play or open a video. Returns a clickable card (displayed automatically) with real title and thumbnail. ' +
      'User can specify by title (e.g. "play the asbestos video"), ordinal (e.g. "play the first video", "play video 3"), or "most viewed". ' +
      'Do NOT describe the video in text or use placeholders - the card shows the actual data.',
    parameters: {
      type: 'OBJECT',
      properties: {
        selector: {
          type: 'STRING',
          description: 'How to pick the video: "first", "last", "most viewed", "least viewed", or a partial title match (e.g. "asbestos").',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'compute_stats_json',
    description:
      'Compute mean, median, std, min, max for any numeric field in the channel JSON. ' +
      'Use when the user asks for statistics, average, distribution, or summary of a numeric column (view_count, like_count, comment_count, duration_seconds).',
    parameters: {
      type: 'OBJECT',
      properties: {
        field: {
          type: 'STRING',
          description: 'Exact field name from the JSON (e.g. view_count, like_count, comment_count).',
        },
      },
      required: ['field'],
    },
  },
];

// Parse ISO 8601 duration (e.g. PT4M13S) to seconds
function parseDuration(dur) {
  if (!dur || typeof dur !== 'string') return null;
  const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const h = parseInt(match[1] || '0', 10);
  const m = parseInt(match[2] || '0', 10);
  const s = parseInt(match[3] || '0', 10);
  return h * 3600 + m * 60 + s;
}

export function executeYoutubeTool(toolName, args, channelData, anchorImage, generateImageFn) {
  const videos = channelData?.videos || [];
  if (!videos.length && toolName !== 'generateImage') {
    return { error: 'No YouTube channel data loaded. Please drag a channel JSON file into the chat first.' };
  }

  switch (toolName) {
    case 'generateImage': {
      if (!generateImageFn) return { error: 'Image generation not available' };
      return generateImageFn(args.prompt, anchorImage); // async - caller must await
    }

    case 'plot_metric_vs_time': {
      const field = args.metric_field;
      const withDates = videos
        .map((v) => {
          let val = v[field];
          if (field === 'duration' || field === 'duration_seconds') {
            val = parseDuration(v.duration || v.duration_seconds) ?? (typeof val === 'number' ? val : null);
          } else {
            val = typeof val === 'number' ? val : parseFloat(val);
          }
          const date = v.published_at || v.release_date;
          return date && val != null && !isNaN(val) ? { date, value: val } : null;
        })
        .filter(Boolean)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      if (!withDates.length) {
        return { error: `No valid data for field "${field}". Available: ${Object.keys(videos[0] || {}).join(', ')}` };
      }
      return {
        _chartType: 'metric_vs_time',
        data: withDates,
        metricField: field,
      };
    }

    case 'play_video': {
      const sel = (args.selector || '').toLowerCase().trim();
      let video = null;
      const ordinals = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, '1st': 0, '2nd': 1, '3rd': 2, '4th': 3, '5th': 4 };
      const videoNumMatch = sel.match(/^video\s+(\d+)$/);
      const plainNum = /^\d+$/.test(sel) ? parseInt(sel, 10) - 1 : null;
      if (sel === 'first' || sel === '1') {
        video = videos[0];
      } else if (ordinals[sel] != null) {
        video = videos[ordinals[sel]];
      } else if (videoNumMatch) {
        video = videos[parseInt(videoNumMatch[1], 10) - 1];
      } else if (plainNum != null && plainNum >= 0) {
        video = videos[plainNum];
      } else if (sel === 'last' || sel === 'most recent') {
        video = videos[videos.length - 1];
      } else if (sel === 'most viewed') {
        video = [...videos].sort((a, b) => (b.view_count || 0) - (a.view_count || 0))[0];
      } else if (sel === 'least viewed') {
        video = [...videos].sort((a, b) => (a.view_count || 0) - (b.view_count || 0))[0];
      } else {
        video = videos.find((v) => (v.title || '').toLowerCase().includes(sel));
      }
      if (!video) return { error: `No video found for "${args.selector}"` };
      // Use YouTube CDN thumbnail (always works) instead of Invidious etc. which can fail
      const thumbUrl = video.video_id
        ? `https://img.youtube.com/vi/${video.video_id}/hqdefault.jpg`
        : (video.thumbnail_url || '');
      return {
        _chartType: 'play_video',
        title: video.title || 'Video',
        thumbnail_url: thumbUrl,
        video_url: video.video_url || `https://www.youtube.com/watch?v=${video.video_id}`,
        video_id: video.video_id,
      };
    }

    case 'compute_stats_json': {
      const field = args.field;
      let values = videos.map((v) => {
        const val = v[field];
        if (field === 'duration' || field === 'duration_seconds') {
          return parseDuration(v.duration || v.duration_seconds) ?? (typeof val === 'number' ? val : null);
        }
        return typeof val === 'number' ? val : parseFloat(val);
      }).filter((v) => v != null && !isNaN(v));
      if (!values.length) {
        return { error: `No numeric values for "${field}". Available: ${Object.keys(videos[0] || {}).join(', ')}` };
      }
      values.sort((a, b) => a - b);
      const sum = values.reduce((a, b) => a + b, 0);
      const mean = sum / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      const std = Math.sqrt(variance);
      const median = values.length % 2 === 0
        ? (values[values.length / 2 - 1] + values[values.length / 2]) / 2
        : values[Math.floor(values.length / 2)];
      return {
        field,
        count: values.length,
        mean: +mean.toFixed(4),
        median: +median.toFixed(4),
        std: +std.toFixed(4),
        min: values[0],
        max: values[values.length - 1],
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
