import { useAppTheme } from '../hooks/useAppTheme.js';
import { Icons } from './Icons.jsx';
import { playSound } from '../utils/soundEngine.js';

export function TaskCheck({ checked, priority, onClick, soundProfile }) {
  const { C, S } = useAppTheme();
  return (
    <div
      style={S.taskCheck(checked, priority)}
      onClick={e => {
        e.stopPropagation();
        if (!checked && soundProfile !== 'none') playSound(soundProfile || 'chirp');
        onClick();
      }}
    >
      {checked && <span style={{ color: '#fff', lineHeight: 1 }}>{Icons.check}</span>}
    </div>
  );
}