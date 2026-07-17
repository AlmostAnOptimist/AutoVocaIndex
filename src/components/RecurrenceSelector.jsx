import { useAppTheme } from '../hooks/useAppTheme.js';
import { RECUR_TYPES, DAYS, WEEKS } from '../constants.js';

export function RecurrenceSelector({ value, onChange }) {
  const { C, S } = useAppTheme();
  const type = value.type || 'none';
  const up = (patch) => onChange({ ...value, ...patch });

  const toggleDay = (day, max = 7) => {
    const days = value.days || [];
    if (days.includes(day)) { up({ days: days.filter(d => d !== day) }); return; }
    if (max && days.length >= max) return;
    up({ days: [...days, day] });
  };

  const ord = (n) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const subFieldStyle = { marginTop: '12px' };
  const subLabelStyle = { fontSize: '11px', fontWeight: 600, color: C.textM, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '8px' };

  return (
    <div>
      <div style={S.recurChips}>
        {RECUR_TYPES.map(r => (
          <div key={r.id} style={S.recurChip(type === r.id)} onClick={() => onChange({ type: r.id })}>
            {r.label}
          </div>
        ))}
      </div>

      {type === 'specific_days' && (
        <div style={subFieldStyle}>
          <div style={subLabelStyle}>Which days?</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {DAYS.map(d => (
              <div key={d} style={S.dayChip((value.days || []).includes(d), false)} onClick={() => toggleDay(d)}>{d}</div>
            ))}
          </div>
          {(value.days || []).length > 0 && (
            <div style={S.infoBox}>Repeats every: {(value.days || []).join(', ')}</div>
          )}
        </div>
      )}

      {type === 'twice_weekly' && (
        <div style={subFieldStyle}>
          <div style={subLabelStyle}>Choose exactly 2 days</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {DAYS.map(d => {
              const sel = (value.days || []).includes(d);
              const dis = (value.days || []).length >= 2 && !sel;
              return (
                <div key={d} style={S.dayChip(sel, dis)} onClick={() => !dis && toggleDay(d, 2)}>{d}</div>
              );
            })}
          </div>
          {(value.days || []).length === 2 && (
            <div style={S.infoBox}>Repeats every {value.days.join(' and ')}</div>
          )}
        </div>
      )}

      {type === 'every_n_days' && (
        <div style={subFieldStyle}>
          <div style={subLabelStyle}>Every how many days?</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input
              type="number" min="2" max="100"
              style={{ ...S.formInput, width: '80px' }}
              value={value.interval || 3}
              onChange={e => up({ interval: Math.max(2, Math.min(100, Number(e.target.value))) })}
            />
            <span style={{ fontSize: '13px', color: C.textS }}>days</span>
          </div>
          <div style={S.infoBox}>Repeats every {value.interval || 3} days from the last occurrence</div>
        </div>
      )}

      {type === 'monthly_date' && (
        <div style={subFieldStyle}>
          <div style={subLabelStyle}>Day of month</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input
              type="number" min="1" max="31"
              style={{ ...S.formInput, width: '80px' }}
              value={value.dayOfMonth || 1}
              onChange={e => up({ dayOfMonth: Math.max(1, Math.min(31, Number(e.target.value))) })}
            />
            <span style={{ fontSize: '13px', color: C.textS }}>of each month</span>
          </div>
          <div style={S.infoBox}>Repeats on the {ord(value.dayOfMonth || 1)} of each month</div>
        </div>
      )}

      {type === 'monthly_relative' && (
        <div style={subFieldStyle}>
          <div style={subLabelStyle}>Which occurrence?</div>
          <div style={S.formRow}>
            <select style={S.formSelect} value={value.week || 'first'} onChange={e => up({ week: e.target.value })}>
              {WEEKS.map(w => <option key={w} value={w}>{w.charAt(0).toUpperCase() + w.slice(1)}</option>)}
            </select>
            <select style={S.formSelect} value={value.dayOfWeek || 'Monday'} onChange={e => up({ dayOfWeek: e.target.value })}>
              {['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(d => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </div>
          <div style={S.infoBox}>Repeats on the {value.week || 'first'} {value.dayOfWeek || 'Monday'} of each month</div>
        </div>
      )}

      {type === 'every_x_months_on_date' && (
        <div style={subFieldStyle}>
          <div style={subLabelStyle}>Interval and date</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', color: C.textS }}>Every</span>
            <input
              type="number" min="1" max="24"
              style={{ ...S.formInput, width: '60px' }}
              value={value.interval || 2}
              onChange={e => up({ interval: Math.max(1, Math.min(24, Number(e.target.value))) })}
            />
            <span style={{ fontSize: '13px', color: C.textS }}>months, on day</span>
            <input
              type="number" min="1" max="31"
              style={{ ...S.formInput, width: '60px' }}
              value={value.dayOfMonth || 1}
              onChange={e => up({ dayOfMonth: Math.max(1, Math.min(31, Number(e.target.value))) })}
            />
          </div>
          <div style={S.infoBox}>Every {value.interval || 2} months on the {ord(value.dayOfMonth || 1)}</div>
        </div>
      )}

      {type === 'every_x_months_on_weekday' && (
        <div style={subFieldStyle}>
          <div style={subLabelStyle}>Interval and weekday</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', color: C.textS }}>Every</span>
            <input
              type="number" min="1" max="24"
              style={{ ...S.formInput, width: '60px' }}
              value={value.interval || 2}
              onChange={e => up({ interval: Math.max(1, Math.min(24, Number(e.target.value))) })}
            />
            <span style={{ fontSize: '13px', color: C.textS }}>months, on the</span>
          </div>
          <div style={{ ...S.formRow, marginTop: '8px' }}>
            <select style={S.formSelect} value={value.week || 'first'} onChange={e => up({ week: e.target.value })}>
              {WEEKS.map(w => <option key={w} value={w}>{w.charAt(0).toUpperCase() + w.slice(1)}</option>)}
            </select>
            <select style={S.formSelect} value={value.dayOfWeek || 'Monday'} onChange={e => up({ dayOfWeek: e.target.value })}>
              {['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(d => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </div>
          <div style={S.infoBox}>Every {value.interval || 2} months on the {value.week || 'first'} {value.dayOfWeek || 'Monday'}</div>
        </div>
      )}

      {type === 'yearly' && (
        <div style={subFieldStyle}>
          <div style={subLabelStyle}>Date of year</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <select
              style={S.formSelect}
              value={value.monthOfYear ?? 0}
              onChange={e => up({ monthOfYear: Number(e.target.value) })}
            >
              {['January','February','March','April','May','June','July','August','September','October','November','December'].map((m, i) => (
                <option key={i} value={i}>{m}</option>
              ))}
            </select>
            <input
              type="number" min="1" max="31"
              style={{ ...S.formInput, width: '60px' }}
              value={value.dayOfMonth || 1}
              onChange={e => up({ dayOfMonth: Math.max(1, Math.min(31, Number(e.target.value))) })}
            />
          </div>
          <div style={S.infoBox}>
            Repeats once per year on {['January','February','March','April','May','June','July','August','September','October','November','December'][value.monthOfYear ?? 0]} {ord(value.dayOfMonth || 1)}
          </div>
        </div>
      )}
    </div>
  );
}