const API = process.env.REACT_APP_API_URL || '';

export const downloadChannelData = async (channelUrl, maxVideos, onProgress) => {
  const res = await fetch(`${API}/api/youtube/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelUrl, maxVideos }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Download failed');
  return data;
};
