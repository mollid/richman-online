import { useState } from 'react';
import {
  availableActions,
  DEPOSIT_MONTHLY_INTEREST,
  fromSerial,
  gameDate,
  MAX_LOAN,
  toSerial,
  type GameState,
  type PlayerAction,
} from '@richman/shared';

const QUICK = [1000, 5000] as const;

/**
 * 银行面板（ECON-01..05）：仅在停留银行格时显示。
 * 存取款 + 贷款（0 利率/3 个月到期）+ 还贷。
 */
export function BankPanel({
  game,
  onAction,
  interactive = true,
}: {
  game: GameState;
  onAction: (a: PlayerAction) => void;
  interactive?: boolean;
}) {
  const actions = availableActions(game);
  const current = game.players[game.currentPlayerIndex];
  const [amount, setAmount] = useState(1000);

  const atBank = actions.canDeposit || actions.canWithdraw || actions.canLoan || actions.canRepayLoan;
  if (!current || !atBank) return null;

  const loan = current.loan;
  const date = gameDate(game);
  const maxDeposit = current.cash;
  const maxWithdraw = current.deposit;
  const maxLoan = MAX_LOAN;
  const maxRepay = loan ? Math.min(current.cash, loan.principal) : 0;

  const dueDate = loan ? fromSerial(toSerial(game.calendar.start) + loan.dueDayIndex) : null;
  const daysLeft = loan ? loan.dueDayIndex - date.dayIndex : 0;

  const send = (type: 'DEPOSIT' | 'WITHDRAW' | 'TAKE_LOAN' | 'REPAY_LOAN', value: number) => {
    const v = Math.floor(value);
    if (v <= 0) return;
    onAction({ type, amount: v });
  };

  return (
    <div className="panel bank-panel">
      <div className="panel-title">银行 · 存取与贷款</div>

      <div className="bank-balance">
        <span>现金 ¥{current.cash.toLocaleString('zh-CN')}</span>
        <span>存款 ¥{current.deposit.toLocaleString('zh-CN')}</span>
      </div>

      <div className="bank-input-row">
        <input
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
        />
        {QUICK.map((q) => (
          <button key={q} className="mini" onClick={() => setAmount(q)}>
            {q}
          </button>
        ))}
        {/* 原来只有一个「全部」，取的是 maxDeposit || maxWithdraw —— 你想「取光」时
            它可能填的却是存款上限。存款与取款的上限是两个数，就分开两个按钮，各带各的数。 */}
        {maxDeposit > 0 && (
          <button
            className="mini"
            title={`把现金全部存进来（¥${maxDeposit.toLocaleString('zh-CN')}）`}
            onClick={() => setAmount(maxDeposit)}
          >
            存满
          </button>
        )}
        {maxWithdraw > 0 && (
          <button
            className="mini"
            title={`把存款全部取出来（¥${maxWithdraw.toLocaleString('zh-CN')}）`}
            onClick={() => setAmount(maxWithdraw)}
          >
            取光
          </button>
        )}
      </div>

      <div className="bank-action-row">
        <button
          disabled={!interactive || !actions.canDeposit || maxDeposit <= 0}
          onClick={() => send('DEPOSIT', amount)}
        >
          存款
        </button>
        <button
          disabled={!interactive || !actions.canWithdraw || maxWithdraw <= 0}
          onClick={() => send('WITHDRAW', amount)}
        >
          取款
        </button>
      </div>

      <div className="bank-loan">
        <div className="bank-loan-info">
          贷款上限 ¥{MAX_LOAN.toLocaleString('zh-CN')} · 利率 0% · 期限 3 个月
        </div>
        {loan ? (
          <>
            <div className="bank-loan-due">
              未还本金 ¥{loan.principal.toLocaleString('zh-CN')}
              {dueDate && ` · 到期 ${dueDate.month} 月 ${dueDate.day} 日（剩 ${daysLeft} 天）`}
            </div>
            <div className="bank-hint">贷款期间存款不发利息</div>
            <div className="bank-action-row">
              <button
                disabled={!interactive || !actions.canRepayLoan || maxRepay <= 0}
                onClick={() => send('REPAY_LOAN', amount)}
              >
                还贷
              </button>
              <button
                disabled={!interactive || !actions.canRepayLoan || maxRepay <= 0}
                onClick={() => send('REPAY_LOAN', maxRepay)}
              >
                全额还清
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="bank-hint">存款按月末结息（月息 {Math.round(DEPOSIT_MONTHLY_INTEREST * 100)}%）</div>
            <div className="bank-action-row">
              <button
                disabled={!interactive || !actions.canLoan || maxLoan <= 0}
                onClick={() => send('TAKE_LOAN', amount)}
              >
                贷款
              </button>
              <button
                disabled={!interactive || !actions.canLoan || maxLoan <= 0}
                onClick={() => send('TAKE_LOAN', maxLoan)}
              >
                贷满 ¥{maxLoan.toLocaleString('zh-CN')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}