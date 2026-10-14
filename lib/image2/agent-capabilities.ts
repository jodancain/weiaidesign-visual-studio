import type { Capabilities } from './types';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 256))] : [];
const operationName = (value: Record<string, unknown>) => String(value.operation || value.name || '');
export interface ImageAgentCapability {
  available: boolean; reason?: string; model?: string; models: string[];
  executionClasses?: string[]; allowedOperations?: string[]; tools?: string[];
}
/** v3 tool control is an explicit CPU-only capability, independent of legacy image-model readiness. */
export function imageAgentCapability(capabilities: Capabilities, schemaVersion?: number): ImageAgentCapability {
  const professional = record(capabilities.professional);
  const source = record(schemaVersion === 3 ? professional.agent : capabilities.agent);
  const executionClasses = strings(source.executionClasses);
  const cpuOnly = executionClasses.length === 1 && executionClasses[0] === 'cpu';
  const available = source.available === true && (schemaVersion !== 3 || cpuOnly && Array.isArray(source.allowedOperations));
  const models = strings(source.models);
  const model = typeof source.model === 'string' && source.model ? source.model : models[0];
  const reason = source.reason === 'agent_unavailable' ? '算法设计助手暂未配置；可继续使用现有编辑按钮。' : typeof source.reason === 'string' ? source.reason : undefined;
  return { available, reason: available ? undefined : reason || (schemaVersion === 3 ? '精确编辑工程的算法设计助手尚未配置；可直接使用编辑工具。' : '设计助手尚未配置；可直接使用编辑工具。'), model, models,
    ...(schemaVersion === 3 ? { executionClasses, allowedOperations: strings(source.allowedOperations), tools: strings(source.tools) } : {}) };
}

/** Existing homepage controls keep reading the top-level capability names. */
export function imageCapabilitiesForDocument(capabilities: Capabilities, schemaVersion?: number): Capabilities {
  if (schemaVersion !== 3) return capabilities;
  const professional = record(capabilities.professional);
  const operations = Array.isArray(professional.operations) ? professional.operations.map(record) : [];
  return { ...capabilities, agent: imageAgentCapability(capabilities, schemaVersion),
    operations: (Array.isArray(capabilities.operations) ? capabilities.operations : []).map(value => {
      const operation = record(value), implemented = operations.find(candidate => operationName(candidate) === operationName(operation));
      const available = implemented?.available === true && implemented.executionClass === 'cpu';
      return { ...operation, available, ...(!available ? { reason: typeof implemented?.reason === 'string' && implemented.reason || '精确编辑工程尚未接通此能力；当前图层与原工程保留。' } : {}) };
    }) };
}

export function requireImageAgent(capabilities: Capabilities, schemaVersion?: number, requestedModel?: string): ImageAgentCapability {
  const status = imageAgentCapability(capabilities, schemaVersion);
  if (!status.available) throw new Error(status.reason);
  if (requestedModel && status.models.length && !status.models.includes(requestedModel)) throw new Error(`所选对话模型 ${requestedModel} 未配置，请选择可用模型。`);
  return status;
}
