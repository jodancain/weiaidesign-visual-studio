export interface AdjustmentField { key: string; label: string; initial: number; min: number; max: number; step: number }
export interface ImageAdjustment { id: string; operation: 'adjust' | 'filter'; label: string; fields: AdjustmentField[] }
const amount = (initial: number, min: number, max: number, step = 1): AdjustmentField => ({ key: 'value', label: '数值', initial, min, max, step });
export const imageAdjustments: ImageAdjustment[] = [
  { id: 'brightness', operation: 'adjust', label: '亮度', fields: [amount(0, -100, 100)] },
  { id: 'contrast', operation: 'adjust', label: '对比度', fields: [amount(0, -100, 100)] },
  { id: 'exposure', operation: 'adjust', label: '曝光', fields: [amount(0, -5, 5, .1)] },
  { id: 'saturation', operation: 'adjust', label: '饱和度', fields: [amount(0, -100, 200)] },
  { id: 'hue', operation: 'adjust', label: '色相', fields: [amount(0, -180, 180)] },
  { id: 'gamma', operation: 'adjust', label: '伽马', fields: [amount(1, .1, 5, .1)] },
  { id: 'grayscale', operation: 'adjust', label: '灰度', fields: [] },
  { id: 'invert', operation: 'adjust', label: '反相', fields: [] },
  { id: 'threshold', operation: 'adjust', label: '阈值', fields: [amount(128, 0, 255)] },
  { id: 'levels', operation: 'adjust', label: '色阶', fields: [
    { key: 'black', label: '黑场', initial: 0, min: 0, max: 254, step: 1 },
    { key: 'white', label: '白场', initial: 255, min: 1, max: 255, step: 1 },
    { key: 'gamma', label: '中间调', initial: 1, min: .1, max: 5, step: .1 },
  ] },
  { id: 'gaussian_blur', operation: 'filter', label: '高斯模糊', fields: [{ key: 'radius', label: '半径', initial: 1, min: .3, max: 20, step: .1 }] },
  { id: 'sharpen', operation: 'filter', label: '锐化', fields: [{ key: 'amount', label: '强度', initial: 1, min: 0, max: 3, step: .1 }] },
  { id: 'median', operation: 'filter', label: '中值降噪', fields: [{ key: 'size', label: '窗口', initial: 3, min: 3, max: 9, step: 2 }] },
];

/** Uses the same explicit operation body as the Agent and pixel service, with no image-model route. */
export function imageAdjustmentRequest(id: string, values: Record<string, string | number>) {
  const choice = imageAdjustments.find(item => item.id === id);
  if (!choice) throw new Error('未注册的调色或滤镜');
  const params: Record<string, number | string> = { kind: id };
  for (const field of choice.fields) {
    const raw = values[field.key] ?? field.initial, value = typeof raw === 'string' && !raw.trim() ? NaN : Number(raw);
    if (!Number.isFinite(value) || value < field.min || value > field.max) throw new Error(`${field.label}需在 ${field.min} 至 ${field.max} 之间`);
    params[field.key] = value;
  }
  if (id === 'levels' && Number(params.black) >= Number(params.white)) throw new Error('色阶黑场必须小于白场');
  if (id === 'median' && ![3, 5, 7, 9].includes(Number(params.size))) throw new Error('中值窗口需为 3、5、7 或 9');
  if (values.feather !== undefined) {
    const feather = typeof values.feather === 'string' && !values.feather.trim() ? NaN : Number(values.feather);
    if (!Number.isFinite(feather) || feather < 0 || feather > 256) throw new Error('选区内羽化需在 0 至 256 像素之间');
    params.feather = feather;
  }
  return { operation: choice.operation, params };
}
