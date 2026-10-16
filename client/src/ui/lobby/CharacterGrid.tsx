import { CHARACTERS } from '@richman/shared';
import { characterPortrait, characterVital } from '../../game/portrait.js';
import './lobby.css';

/**
 * 角色格。
 *
 * 用的是定稿立绘（`/art/char_<id>@v6.png`），不是 `characters.ts` 里那个 emoji ——
 * emoji 只是波 3 素材没到位时的占位，棋盘与 HUD 早就换成图了，选角这一格不该还停在占位上。
 */
export function CharacterGrid({
  picked,
  onToggle,
  taken,
}: {
  /** 座位序的角色 id 列表：下标即座位号，卡片右上角的徽章就是它 */
  picked: string[];
  onToggle: (characterId: string) => void;
  /** 角色 id → 占用人名字。联机大厅用它标「谁占了谁」 */
  taken?: Record<string, string | undefined>;
}) {
  return (
    <div className="lb-chars">
      {CHARACTERS.map((c) => {
        const seat = picked.indexOf(c.id);
        const holder = taken?.[c.id];
        const mine = seat >= 0;
        const takenByOther = !!holder && !mine;
        return (
          <button
            key={c.id}
            type="button"
            className={`lb-char${mine ? ' lb-char--on' : ''}`}
            title={takenByOther ? `${holder} 占着` : c.blurb}
            aria-pressed={mine}
            disabled={takenByOther}
            onClick={() => onToggle(c.id)}
          >
            <img className="lb-char__pic" src={characterPortrait(c.id)} alt={c.name} width={68} height={68} draggable={false} />
            <span className="lb-char__name">{c.name}</span>
            <span className="lb-char__meta">{takenByOther ? holder : characterVital(c)}</span>
            {mine && <span className="lb-char__seat">{seat + 1} 号位</span>}
            {takenByOther && <span className="lb-char__taken">已选</span>}
          </button>
        );
      })}
    </div>
  );
}
