import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import './MetricVsTimeChart.css';

export default function MetricVsTimeChart({ data, metricField }) {
  const [enlarged, setEnlarged] = useState(false);

  const chartData = (data || []).map((d) => ({
    ...d,
    dateShort: d.date ? new Date(d.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' }) : '',
  }));

  const downloadChart = () => {
    const svg = document.querySelector('.metric-vs-time-chart .recharts-surface');
    if (svg) {
      const svgData = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `plot_${metricField}_vs_time.svg`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    }
  };

  const chart = (
    <div className="metric-vs-time-chart" onClick={() => setEnlarged(true)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setEnlarged(true)}>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
          <XAxis dataKey="dateShort" stroke="#888" fontSize={11} />
          <YAxis stroke="#888" fontSize={11} />
          <Tooltip
            contentStyle={{ background: '#1a1a2e', border: '1px solid #333' }}
            labelStyle={{ color: '#fff' }}
            formatter={(v) => [v?.toLocaleString?.() ?? v, metricField]}
          />
          <Line type="monotone" dataKey="value" stroke="#e50914" strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
      <div className="metric-chart-actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => setEnlarged(true)}>Enlarge</button>
        <button type="button" onClick={downloadChart}>Download</button>
      </div>
    </div>
  );

  if (enlarged) {
    return (
      <div className="metric-chart-lightbox" onClick={() => setEnlarged(false)} role="dialog" aria-modal="true">
        <div className="metric-chart-lightbox-content" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="metric-chart-close" onClick={() => setEnlarged(false)} aria-label="Close">×</button>
          <div className="metric-vs-time-chart metric-vs-time-chart-enlarged">
            <LineChart width={700} height={450} data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
              <XAxis dataKey="dateShort" stroke="#888" fontSize={12} />
              <YAxis stroke="#888" fontSize={12} />
              <Tooltip
                contentStyle={{ background: '#1a1a2e', border: '1px solid #333', maxWidth: 200 }}
                labelStyle={{ color: '#fff' }}
                formatter={(v) => [v?.toLocaleString?.() ?? v, metricField]}
                cursor={{ stroke: 'rgba(255,255,255,0.2)', strokeWidth: 1 }}
              />
              <Line type="monotone" dataKey="value" stroke="#e50914" strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
            </LineChart>
            <div className="metric-chart-actions">
              <button type="button" onClick={downloadChart}>Download</button>
              <button type="button" onClick={() => setEnlarged(false)}>Close</button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return chart;
}
