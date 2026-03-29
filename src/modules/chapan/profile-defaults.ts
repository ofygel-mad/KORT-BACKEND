export const DEFAULT_CHAPAN_PROFILE = {
  displayName: 'Экспериментальный модуль',
  descriptor: 'Рабочее пространство производства',
  orderPrefix: 'EXP',
  publicIntakeTitle: 'Экспериментальный модуль',
  publicIntakeDescription: '',
  publicIntakeEnabled: true,
  supportLabel: '',
} as const;

export const LEGACY_CHAPAN_PROFILE = {
  displayName: 'Чапан',
  descriptor: 'Система управления производством одежды',
  orderPrefix: 'ЧП',
  publicIntakeTitle: 'Оформление заказа на Чапан',
  publicIntakeDescription: '',
  publicIntakeEnabled: true,
  supportLabel: '',
} as const;
