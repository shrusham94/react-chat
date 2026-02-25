import { useState } from 'react';
import './GeneratedImage.css';

export default function GeneratedImage({ imageData, mimeType, prompt }) {
  const [enlarged, setEnlarged] = useState(false);
  const src = imageData ? `data:${mimeType || 'image/png'};base64,${imageData}` : null;

  const downloadImage = () => {
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = `generated_${Date.now()}.png`;
    a.click();
  };

  if (!src) return null;

  return (
    <>
      <div className="generated-image-wrap">
        <img
          src={src}
          alt={prompt || 'Generated image'}
          className="generated-image-thumb"
          onClick={() => setEnlarged(true)}
        />
        <div className="generated-image-actions">
          <button type="button" onClick={() => setEnlarged(true)}>Enlarge</button>
          <button type="button" onClick={downloadImage}>Download</button>
        </div>
      </div>
      {enlarged && (
        <div className="generated-image-lightbox" onClick={() => setEnlarged(false)}>
          <div className="generated-image-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="generated-image-close" onClick={() => setEnlarged(false)}>×</button>
            <img src={src} alt={prompt || 'Generated'} />
            <button type="button" onClick={downloadImage}>Download</button>
          </div>
        </div>
      )}
    </>
  );
}
