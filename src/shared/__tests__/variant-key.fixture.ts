// Golden fixture for the canonical variant-key contract.
//
// This file MUST be kept byte-identical with src/shared/utils/__tests__/variantKey.fixture.ts
// on the frontend. Both contract tests load the same cases and assert identical output;
// any drift fails CI before it can desync the warehouse and order-form lookup paths.

export interface FixtureCase {
  name: string;
  productName: string;
  attributes: Record<string, string | null | undefined>;
  fields: { code: string; affectsAvailability: boolean }[];
  expected: string;
}

const ALL_AXES = [
  { code: 'color',  affectsAvailability: true },
  { code: 'gender', affectsAvailability: true },
  { code: 'length', affectsAvailability: true },
  { code: 'size',   affectsAvailability: true },
];

const GENDER_OFF = [
  { code: 'color',  affectsAvailability: true },
  { code: 'gender', affectsAvailability: false },
  { code: 'length', affectsAvailability: true },
  { code: 'size',   affectsAvailability: true },
];

export const VARIANT_KEY_FIXTURES: FixtureCase[] = [
  {
    name: 'all axes filled, gender on',
    productName: 'Абай бомбер',
    attributes: { color: 'Белый', gender: 'Мужской', length: 'Длинный', size: '38' },
    fields: ALL_AXES,
    expected: 'абай бомбер|color:белый|gender:мужской|length:длинный|size:38',
  },
  {
    name: 'gender off → key omits gender',
    productName: 'Абай бомбер',
    attributes: { color: 'Белый', gender: 'Мужской', length: 'Длинный', size: '38' },
    fields: GENDER_OFF,
    expected: 'абай бомбер|color:белый|length:длинный|size:38',
  },
  {
    name: 'gender on but value empty → key omits gender',
    productName: 'Абай бомбер',
    attributes: { color: 'Белый', gender: '', length: 'Длинный', size: '38' },
    fields: ALL_AXES,
    expected: 'абай бомбер|color:белый|length:длинный|size:38',
  },
  {
    name: 'whitespace and case normalization',
    productName: '  АБАЙ   БОМБЕР  ',
    attributes: { color: '  БЕЛЫЙ ', gender: ' Мужской', length: 'Длинный', size: ' 38 ' },
    fields: ALL_AXES,
    expected: 'абай бомбер|color:белый|gender:мужской|length:длинный|size:38',
  },
  {
    name: 'no attributes → name only',
    productName: 'Абай бомбер',
    attributes: {},
    fields: ALL_AXES,
    expected: 'абай бомбер',
  },
  {
    name: 'attribute outside fields ignored',
    productName: 'Абай бомбер',
    attributes: { color: 'Белый', size: '38', extra: 'stuff' } as Record<string, string>,
    fields: ALL_AXES,
    expected: 'абай бомбер|color:белый|size:38',
  },
  {
    name: 'null/undefined values dropped',
    productName: 'Абай бомбер',
    attributes: { color: null, gender: undefined, length: 'Длинный', size: '40' },
    fields: ALL_AXES,
    expected: 'абай бомбер|length:длинный|size:40',
  },
  {
    name: 'unicode order is alphabetical by code, not by value',
    productName: 'Назар',
    attributes: { size: 'M', color: 'Я', gender: 'А' },
    fields: ALL_AXES,
    expected: 'назар|color:я|gender:а|size:m',
  },
];
