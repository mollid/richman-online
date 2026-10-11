import { availableActions } from '@richman/shared';
import type { AvailableActions, GameState, PlayerAction } from '@richman/shared';

/**
 * 落格决策窗的那**一个**出口（R4）。
 *
 * 玩家手上没有常驻的「结束回合」：单步格给一句「不…」的 decline（按下去什么都不买、
 * 什么都不做，直接把这一格交出去），会话型场所给「离开商店 / 办完离开」——
 * 那里的动作可以反复办，只有离开才推进回合。
 *
 * 标题取自窗口里**此刻真正可办的那件事**，而不是固定写「结束回合」：面板上明晃晃一个
 * 「买下」按钮旁边写着「结束回合」，玩家会以为按下去是跳过买地这一步之外的所有东西。
 *
 * 注意：`client/public/ac-hud/hud.js` 里有一份同逻辑的拷贝 —— HUD 本体是不经打包器加载的
 * vanilla 全局脚本，导不进这个模块。改口径时两边一起改。
 */
export function landingExitLabel(actions: AvailableActions): string | null {
  if (!actions.canFinishLanding) return null;
  const venue = actions.landing?.venue ?? null;
  if (venue === 'shop') return '🚪 离开商店';
  if (venue === 'bank') return '🚪 办完离开';
  if (actions.canBuy) return '✋ 不买这块地';
  if (actions.canUpgrade) return '✋ 不加盖';
  if (actions.buildableFacilities.length > 0) return '✋ 暂不建设';
  if (actions.researchableItems.length > 0) return '✋ 暂不研发';
  if (actions.canBuyShares) return '✋ 不认购原始股';
  if (actions.bailableVillains.length > 0) return '✋ 不保释';
  if (actions.dischargeablePatients.length > 0) return '✋ 不办理出院';
  if (actions.canBuyLottery) return '✋ 不买乐透';
  if (actions.magic) return '✋ 不施法';
  if (actions.estateBuildCells.length > 0) return '✋ 不加盖任何地产';
  return '✋ 这一格不做处理';
}

/** 出口按钮要发出去的那个动作（不在落格窗里时为 null） */
export function landingExitAction(): PlayerAction {
  return { type: 'FINISH_LANDING' };
}

/**
 * 回车键（`confirm`）该发什么：只在**推进流程**里选，绝不花钱。
 * 落格窗里 = 走出这一格；否则 = 掷骰。
 */
export function confirmAction(game: GameState): PlayerAction {
  return availableActions(game).canFinishLanding ? landingExitAction() : { type: 'ROLL_DICE' };
}
