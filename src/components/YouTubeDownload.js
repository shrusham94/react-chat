import { useState } from 'react';
import { downloadChannelData } from '../services/youtubeApi';
import './YouTubeDownload.css';

export default function YouTubeDownload({ onBack }) {
  const [channelUrl, setChannelUrl] = useState('https://www.youtube.com/@veritasium');
  const [maxVideos, setMaxVideos] = useState(10);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleDownload = async () => {
    setError('');
    setResult(null);
    setLoading(true);
    setProgress(0);
    const interval = setInterval(() => {
      setProgress((p) => Math.min(p + 5, 90));
    }, 500);
    try {
      const data = await downloadChannelData(channelUrl, maxVideos);
      clearInterval(interval);
      setProgress(100);
      setResult(data);
    } catch (err) {
      clearInterval(interval);
      setError(err.message || 'Download failed');
    } finally {
      setLoading(false);
    }
  };

  const downloadJson = () => {
    if (!result?.data) return;
    const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename || 'youtube_channel.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="youtube-download">
      <header className="youtube-download-header">
        <button type="button" className="youtube-back-btn" onClick={onBack}>
          ← Back to Chat
        </button>
        <h1>YouTube Channel Download</h1>
      </header>
      <div className="youtube-download-content">
        <div className="youtube-form">
          <label>
            Channel URL
            <input
              type="url"
              placeholder="https://www.youtube.com/@channelname"
              value={channelUrl}
              onChange={(e) => setChannelUrl(e.target.value)}
              disabled={loading}
            />
          </label>
          <label>
            Max videos (1–100)
            <input
              type="number"
              min={1}
              max={100}
              value={maxVideos}
              onChange={(e) => setMaxVideos(Math.min(100, Math.max(1, parseInt(e.target.value, 10) || 10)))}
              disabled={loading}
            />
          </label>
          <button
            type="button"
            className="youtube-download-btn"
            onClick={handleDownload}
            disabled={loading}
          >
            {loading ? 'Downloading…' : 'Download Channel Data'}
          </button>
        </div>
        {loading && (
          <div className="youtube-progress-wrap">
            <div className="youtube-progress-bar" style={{ width: `${progress}%` }} />
          </div>
        )}
        {error && <p className="youtube-error">{error}</p>}
        {result && (
          <div className="youtube-result">
            <p className="youtube-success">
              Downloaded {result.data?.videos?.length || 0} videos.
            </p>
            <button type="button" className="youtube-json-btn" onClick={downloadJson}>
              Download JSON
            </button>
            <p className="youtube-filename">Saved as: {result.filename}</p>
          </div>
        )}
      </div>
    </div>
  );
}
