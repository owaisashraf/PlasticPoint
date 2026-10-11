import { BarController, BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip } from 'chart.js';
import { formatPaisa, type Dashboard } from '@shopledger/shared';
import { Chart } from 'react-chartjs-2';

// A mixed bar + line chart needs both controllers as well as their elements.
ChartJS.register(BarController, LineController, CategoryScale, LinearScale, BarElement, LineElement, PointElement, Tooltip, Legend);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * 12-month profit trend (CLAUDE.md 11.3 #10): gross profit as bars, net
 * profit as a line. Loaded only when the owner's dashboard shows it.
 */
export default function ProfitTrendChart({ trend }: { trend: NonNullable<Dashboard['profit_trend']> }) {
  // Chart.js works in numbers; rupees are only for drawing, the labels use paisa.
  const rupees = (p: number) => Math.round(p / 100);
  return (
    <Chart
      type="bar"
      aria-label="Profit for the last 12 months"
      data={{
        labels: trend.map((t) => `${MONTHS[Number(t.month.slice(5, 7)) - 1]} ${t.month.slice(2, 4)}`),
        datasets: [
          { type: 'bar', label: 'Gross profit', data: trend.map((t) => rupees(t.gross_profit_paisa)), backgroundColor: '#93c5fd' },
          { type: 'line', label: 'Net profit', data: trend.map((t) => rupees(t.net_profit_paisa)), borderColor: '#1e3a8a', backgroundColor: '#1e3a8a', tension: 0.2 },
        ],
      }}
      options={{
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: (c) => {
                const t = trend[c.dataIndex];
                if (!t) return '';
                return `${c.dataset.label}: ${formatPaisa(c.datasetIndex === 0 ? t.gross_profit_paisa : t.net_profit_paisa)}`;
              },
            },
          },
        },
        scales: { y: { ticks: { callback: (v) => `Rs ${Number(v).toLocaleString('en-PK')}` } } },
      }}
    />
  );
}
