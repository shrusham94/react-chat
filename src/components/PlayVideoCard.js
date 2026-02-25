import './PlayVideoCard.css';

// Ensure we open the full YouTube watch page, not an embed
function toWatchUrl(url, videoId) {
  if (!url || !url.startsWith('http')) return url || '#';
  const id = videoId || (url.match(/[?&]v=([^&]+)/) || url.match(/\/embed\/([^?&]+)/) || [])[1];
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return url;
}

// YouTube CDN thumbnail - always works (Invidious etc. can fail)
const thumbUrl = (url, id) =>
  (id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null) || (url && url.startsWith('http') ? url : null);

export default function PlayVideoCard({ title, thumbnail_url, video_url, video_id }) {
  const watchUrl = toWatchUrl(video_url, video_id);
  const imgSrc = thumbUrl(thumbnail_url, video_id);

  const handleClick = (e) => {
    e.preventDefault();
    if (watchUrl.startsWith('http')) {
      window.open(watchUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <a
      href={watchUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className="play-video-card"
    >
      <div className="play-video-thumb">
        {imgSrc && <img src={imgSrc} alt="" />}
      </div>
      <div className="play-video-info">
        <div className="play-video-title">{title || 'Video'}</div>
        <span className="play-video-hint">Open on YouTube →</span>
      </div>
    </a>
  );
}
