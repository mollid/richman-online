import type { BoardCell } from './types.js';

/**
 * 40 格环形棋盘（11x11 网格外圈，顺时针行走）。
 * 布局数据与渲染解耦：客户端负责把 cellId 映射到等距坐标。
 */
export const BOARD_SIZE = 40;

export const STARTING_CASH = 15000;
export const PASS_START_SALARY = 2000;

function cell(id: number, type: BoardCell['type'], name: string, extra: Partial<BoardCell> = {}): BoardCell {
  return { id, type, name, ...extra };
}

const P = (id: number, name: string, price: number, baseRent: number, group: BoardCell['group']): BoardCell =>
  cell(id, 'property', name, { price, baseRent, group });

export const DEFAULT_BOARD: BoardCell[] = [
  cell(0, 'start', '起点'),
  P(1, '桃园路', 300, 80, 'residential'),
  P(2, '中山路', 320, 85, 'residential'),
  cell(3, 'chance', '机会'),
  P(4, '成都路', 350, 90, 'residential'),
  cell(5, 'neutral', '中央公园'),
  P(6, '南京路', 500, 130, 'commercial'),
  cell(7, 'chance', '机会'),
  P(8, '淮海路', 520, 135, 'commercial'),
  P(9, '王府井', 550, 140, 'commercial'),
  P(10, '铜锣湾', 580, 150, 'commercial'),
  cell(11, 'chance', '机会'),
  P(12, '铁西区', 450, 110, 'industrial'),
  P(13, '经开区', 470, 115, 'industrial'),
  cell(14, 'hospital', '医院'),
  P(15, '高新区', 500, 125, 'industrial'),
  P(16, '科学城', 520, 130, 'industrial'),
  cell(17, 'chance', '机会'),
  P(18, '中关村', 700, 180, 'tech'),
  P(19, '张江', 720, 185, 'tech'),
  P(20, '深圳湾', 750, 195, 'tech'),
  cell(21, 'tax', '缴税'),
  P(22, '光谷', 780, 200, 'tech'),
  cell(23, 'chance', '机会'),
  P(24, '鼓浪屿', 650, 165, 'coastal'),
  P(25, '亚龙湾', 680, 170, 'coastal'),
  cell(26, 'jail', '监狱'),
  P(27, '金石滩', 700, 175, 'coastal'),
  P(28, '银滩', 720, 180, 'coastal'),
  cell(29, 'chance', '机会'),
  P(30, '陆家嘴', 900, 230, 'financial'),
  P(31, '金融街', 880, 225, 'financial'),
  P(32, '中环', 920, 235, 'financial'),
  P(33, '曼哈顿', 950, 240, 'financial'),
  cell(34, 'chance', '机会'),
  cell(35, 'neutral', '银行'),
  P(36, '西门町', 340, 88, 'residential'),
  P(37, '士林夜市', 360, 92, 'residential'),
  cell(38, 'neutral', '新闻社'),
  P(39, '迪化街', 380, 95, 'residential'),
];

/** 机会格随机事件表（M1 简化为现金事件，M2 替换为完整卡片系统） */
export interface ChanceEvent {
  text: string;
  amount: number;
}

export const CHANCE_EVENTS: ChanceEvent[] = [
  { text: '中了彩票小奖，获得 ¥1000', amount: 1000 },
  { text: '捡到钱包，交还失主获酬谢 ¥500', amount: 500 },
  { text: '收到公司分红 ¥800', amount: 800 },
  { text: '违章停车被罚款 ¥300', amount: -300 },
  { text: '感冒看病花了 ¥600', amount: -600 },
  { text: '请朋友吃饭花了 ¥400', amount: -400 },
];
