/**
 * Local validation of the checked-in WhatsApp assets:
 *   - Flow JSON structure (version 7.0 conventions, dynamic references, terminal actions)
 *   - Flow response fixtures against the adapter's bounded response parser
 *   - Template specifications against the adapter's parameter mapping
 *
 * Usage:
 *   pnpm whatsapp:validate                       # local checks only (no network)
 *   pnpm whatsapp:validate --live                # also GET template status from Meta (read-only)
 *   pnpm whatsapp:validate --live --upload-flow MULTI_CHOICE=<flowId> --apply
 *                                                # upload the Flow JSON asset to an existing DRAFT flow
 *                                                # and print Meta's validation errors (modifies a Meta asset)
 *
 * Meta's Flow builder / asset upload response remains the authoritative validator. Nothing here
 * marks a template approved or a Flow published.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FLOW_PURPOSES, TEMPLATE_PURPOSES, type FlowPurpose, type TemplatePurpose } from '@raaye/contracts';
import { loadConfig } from '../libs/server/src/config/env';
import { flowAssetVersion, loadFlowAsset } from '../libs/server/src/messaging/flow-assets';
import { MetaManagementClient } from '../libs/server/src/messaging/meta-management';
import { DEFAULT_TEMPLATE_NAMES } from '../libs/server/src/messaging/planner';
import { parseFlowResponse } from '../libs/server/src/messaging/webhook-parser';

const ROOT = path.resolve(__dirname, '..');
const problems: string[] = [];
const notes: string[] = [];

function fail(message: string): void {
  problems.push(message);
}

const COMPONENT_TYPES = new Set([
  'TextHeading',
  'TextSubheading',
  'TextBody',
  'TextCaption',
  'RichText',
  'Form',
  'TextInput',
  'TextArea',
  'CheckboxGroup',
  'RadioButtonsGroup',
  'ChipsSelector',
  'Dropdown',
  'Footer',
  'OptIn',
  'EmbeddedLink',
  'DatePicker',
  'CalendarPicker',
  'Image',
  'If',
  'Switch',
  'NavigationList',
  'PhotoPicker',
  'DocumentPicker',
]);
const INPUT_TYPES = new Set(['TextInput', 'TextArea', 'CheckboxGroup', 'RadioButtonsGroup', 'ChipsSelector', 'Dropdown', 'OptIn', 'DatePicker', 'CalendarPicker', 'PhotoPicker', 'DocumentPicker']);
const SOURCE_TYPES = new Set(['CheckboxGroup', 'RadioButtonsGroup', 'ChipsSelector', 'Dropdown']);
const ACTION_NAMES = new Set(['complete', 'navigate', 'data_exchange', 'open_url', 'update_data']);
const RESPONSE_KEYS = new Set(['flow_token', 'action_token', 'selected', 'selected_option_ids', 'selection', 'city', 'district', 'gender', 'age_band', 'occupation', 'membership']);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectReferences(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{(data|form|screen)\.([A-Za-z0-9_]+)\}/g)) into.add(`${match[1]}.${match[2]}`);
  } else if (Array.isArray(value)) value.forEach((item) => collectReferences(item, into));
  else if (isObject(value)) Object.values(value).forEach((item) => collectReferences(item, into));
}

interface ScreenReport {
  completePayloadKeys: string[];
  hasDataExchange: boolean;
}

function validateComponent(component: unknown, where: string, formFields: Set<string>, report: ScreenReport, footers: { count: number }): void {
  if (!isObject(component) || typeof component['type'] !== 'string') {
    fail(`${where}: component must be an object with a string type`);
    return;
  }
  const type = component['type'];
  if (!COMPONENT_TYPES.has(type)) fail(`${where}: unsupported component type ${type}`);
  if (INPUT_TYPES.has(type)) {
    if (typeof component['name'] !== 'string' || !/^[a-z][a-z0-9_]*$/.test(component['name'])) fail(`${where}: ${type} needs a snake_case name`);
    else formFields.add(component['name']);
    if (type !== 'OptIn' && typeof component['label'] !== 'string') fail(`${where}: ${type} needs a label`);
    if (component['required'] !== undefined && typeof component['required'] !== 'boolean') fail(`${where}: required must be boolean`);
  }
  if (SOURCE_TYPES.has(type) && component['data-source'] === undefined) fail(`${where}: ${type} needs data-source`);
  if (type === 'Form') {
    if (typeof component['name'] !== 'string') fail(`${where}: Form needs a name`);
    const children = component['children'];
    if (!Array.isArray(children) || children.length === 0) fail(`${where}: Form needs children`);
    else children.forEach((child, index) => validateComponent(child, `${where}.children[${index}]`, formFields, report, footers));
  }
  if (type === 'Footer') {
    footers.count += 1;
    if (typeof component['label'] !== 'string' || component['label'].length === 0 || component['label'].length > 35) fail(`${where}: Footer label must be 1-35 characters`);
    const action = component['on-click-action'];
    if (!isObject(action) || typeof action['name'] !== 'string' || !ACTION_NAMES.has(action['name'])) fail(`${where}: Footer needs a valid on-click-action`);
    else {
      if (action['name'] === 'data_exchange') report.hasDataExchange = true;
      if (action['name'] === 'complete') {
        const payload = action['payload'];
        if (!isObject(payload)) fail(`${where}: complete action needs a payload object`);
        else report.completePayloadKeys.push(...Object.keys(payload));
      }
    }
  }
}

function validateFlow(purpose: FlowPurpose): void {
  const asset = loadFlowAsset(purpose);
  const where = `flows/${asset.file}`;
  const json = asset.json;
  if (json['version'] !== '7.0') fail(`${where}: version must be "7.0" (got ${String(json['version'])})`);
  const screens = json['screens'];
  if (!Array.isArray(screens) || screens.length === 0) {
    fail(`${where}: screens must be a non-empty array`);
    return;
  }
  const usesEndpoint = { value: false };
  const screenIds = new Set<string>();
  screens.forEach((screen, index) => {
    const at = `${where}.screens[${index}]`;
    if (!isObject(screen)) {
      fail(`${at}: screen must be an object`);
      return;
    }
    const id = screen['id'];
    if (typeof id !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(id) || id === 'SUCCESS') fail(`${at}: invalid screen id ${String(id)}`);
    else if (screenIds.has(id)) fail(`${at}: duplicate screen id ${id}`);
    else screenIds.add(id);
    if (typeof screen['title'] !== 'string' || screen['title'].length === 0 || screen['title'].length > 30) fail(`${at}: title must be 1-30 characters`);
    const data = screen['data'];
    const dataKeys = new Set<string>();
    if (data !== undefined) {
      if (!isObject(data)) fail(`${at}: data must be an object`);
      else {
        for (const [key, definition] of Object.entries(data)) {
          if (!isObject(definition) || typeof definition['type'] !== 'string' || !('__example__' in definition)) fail(`${at}.data.${key}: needs type and __example__`);
          dataKeys.add(key);
        }
      }
    }
    const layout = screen['layout'];
    if (!isObject(layout) || layout['type'] !== 'SingleColumnLayout' || !Array.isArray(layout['children'])) {
      fail(`${at}: layout must be a SingleColumnLayout with children`);
      return;
    }
    const formFields = new Set<string>();
    const report: ScreenReport = { completePayloadKeys: [], hasDataExchange: false };
    const footers = { count: 0 };
    (layout['children'] as unknown[]).forEach((child, childIndex) => validateComponent(child, `${at}.layout.children[${childIndex}]`, formFields, report, footers));
    if (footers.count !== 1) fail(`${at}: exactly one Footer is required (found ${footers.count})`);
    if (screen['terminal'] === true && report.completePayloadKeys.length === 0 && !report.hasDataExchange) fail(`${at}: terminal screen must finish with a complete or data_exchange action`);
    if (report.hasDataExchange) usesEndpoint.value = true;
    const references = new Set<string>();
    collectReferences(layout, references);
    for (const reference of references) {
      const [scope, name] = reference.split('.');
      if (scope === 'data' && !dataKeys.has(name)) fail(`${at}: ${'${'}data.${name}} is not declared in data`);
      if (scope === 'form' && !formFields.has(name)) fail(`${at}: ${'${'}form.${name}} does not match a form field`);
    }
    for (const key of report.completePayloadKeys) if (!RESPONSE_KEYS.has(key)) fail(`${at}: complete payload key "${key}" is not accepted by the inbound Flow response parser`);
    if (asset.screen === id) {
      if (!report.completePayloadKeys.includes('action_token')) fail(`${at}: the ${purpose} flow must return action_token`);
      const sample: Record<string, unknown> = {};
      for (const key of report.completePayloadKeys) sample[key] = key === 'selected' || key === 'selected_option_ids' ? ['11111111-1111-4111-8111-111111111111'] : 'value';
      if (!parseFlowResponse(JSON.stringify(sample))) fail(`${at}: a response with keys ${report.completePayloadKeys.join(', ')} is rejected by parseFlowResponse`);
    }
  });
  if (!screenIds.has(asset.screen)) fail(`${where}: expected entry screen ${asset.screen}`);
  if (screens.length > 1 && !isObject(json['routing_model'])) fail(`${where}: routing_model is required for multi-screen flows`);
  if (!usesEndpoint.value && json['data_api_version'] !== undefined) fail(`${where}: data_api_version is only valid for flows with a data endpoint`);
  if (usesEndpoint.value && json['data_api_version'] === undefined) fail(`${where}: data_api_version is required when data_exchange is used`);
  notes.push(`${where}: ${screens.length} screen(s), asset version ${flowAssetVersion(purpose)}`);
}

function validateFixtures(): void {
  const directory = path.join(ROOT, 'whatsapp/fixtures');
  const expectations: Record<string, (response: Record<string, unknown>) => string | null> = {
    'flow-response-multi.json': (r) => (Array.isArray(r['selected']) && r['selected'].length > 0 ? null : 'selected[] missing'),
    'flow-response-single.json': (r) => (typeof r['selection'] === 'string' && r['selection'].length > 0 ? null : 'selection missing'),
    'flow-response-profile.json': (r) => (['city', 'district', 'gender', 'age_band', 'occupation', 'membership'].some((key) => key in r) ? null : 'no profile field present'),
  };
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const text = readFileSync(path.join(directory, file), 'utf8');
    const parsed = parseFlowResponse(text);
    if (!parsed) {
      fail(`fixtures/${file}: rejected by parseFlowResponse`);
      continue;
    }
    if (typeof parsed['action_token'] !== 'string' && typeof parsed['flow_token'] !== 'string') fail(`fixtures/${file}: no action_token / flow_token`);
    const check = expectations[file];
    const issue = check ? check(parsed) : null;
    if (issue) fail(`fixtures/${file}: ${issue}`);
    notes.push(`fixtures/${file}: accepted (${Object.keys(parsed).join(', ')})`);
  }
}

interface TemplateSpec {
  purpose: TemplatePurpose;
  name: string;
  language: string;
  category: string;
  components: { type: string; text?: string; example?: { body_text?: string[][] }; buttons?: { type: string; text: string }[] }[];
  adapterMapping: { body: string[]; button: { index: number; sub_type: string; payload: string } };
}

function validateTemplates(): TemplateSpec[] {
  const directory = path.join(ROOT, 'whatsapp/templates');
  const specs: TemplateSpec[] = [];
  const seen = new Set<TemplatePurpose>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const where = `templates/${file}`;
    const raw: unknown = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
    if (!isObject(raw)) {
      fail(`${where}: not an object`);
      continue;
    }
    const purpose = raw['purpose'];
    if (typeof purpose !== 'string' || !(TEMPLATE_PURPOSES as readonly string[]).includes(purpose)) {
      fail(`${where}: unknown purpose ${String(purpose)}`);
      continue;
    }
    const spec = raw as unknown as TemplateSpec;
    seen.add(spec.purpose);
    if (!/^[a-z0-9_]{1,512}$/.test(spec.name)) fail(`${where}: template names must be lowercase letters, digits and underscores`);
    if (spec.name !== DEFAULT_TEMPLATE_NAMES[spec.purpose]) notes.push(`${where}: name ${spec.name} differs from the adapter default ${DEFAULT_TEMPLATE_NAMES[spec.purpose]}; bind it explicitly in Settings → Messaging`);
    if (!['UTILITY', 'MARKETING'].includes(spec.category)) fail(`${where}: category must be UTILITY or MARKETING`);
    const body = spec.components.find((component) => component.type === 'BODY');
    if (!body?.text) fail(`${where}: BODY component missing`);
    else {
      const placeholders = [...body.text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
      if (placeholders.join(',') !== '1,2') fail(`${where}: BODY must use exactly {{1}} and {{2}} in order (organization name, survey title)`);
      if (body.text.length > 1024) fail(`${where}: BODY exceeds 1,024 characters`);
      if (!body.example?.body_text?.[0] || body.example.body_text[0].length !== 2) fail(`${where}: BODY example must provide two sample values`);
    }
    const buttons = spec.components.find((component) => component.type === 'BUTTONS')?.buttons ?? [];
    if (buttons.length !== 1 || buttons[0].type !== 'QUICK_REPLY') fail(`${where}: exactly one QUICK_REPLY button is required`);
    if (buttons[0] && buttons[0].text.length > 25) fail(`${where}: button text exceeds 25 characters`);
    if (JSON.stringify(spec.adapterMapping?.body) !== JSON.stringify(['organization_name', 'survey_title'])) fail(`${where}: adapterMapping.body must be [organization_name, survey_title]`);
    if (spec.adapterMapping?.button?.sub_type !== 'quick_reply' || spec.adapterMapping.button.payload !== 'action_token' || spec.adapterMapping.button.index !== 0) fail(`${where}: adapterMapping.button must be quick_reply index 0 carrying action_token`);
    specs.push(spec);
    notes.push(`${where}: ${spec.purpose} → ${spec.name} (${spec.language}, ${spec.category})`);
  }
  for (const purpose of TEMPLATE_PURPOSES) if (!seen.has(purpose)) fail(`templates: no specification for ${purpose}`);
  return specs;
}

async function liveChecks(specs: TemplateSpec[], args: string[]): Promise<void> {
  const config = loadConfig(process.env);
  if (!config.META_ACCESS_TOKEN || !config.META_WABA_ID) {
    fail('live: META_ACCESS_TOKEN and META_WABA_ID are required for --live');
    return;
  }
  const client = new MetaManagementClient(config);
  for (const spec of specs) {
    const status = await client.templateStatus(config.META_WABA_ID, spec.name);
    if (status.length === 0) notes.push(`live: template ${spec.name} is not registered on WABA ${config.META_WABA_ID}`);
    for (const item of status) notes.push(`live: template ${item.name} (${item.language}) status=${item.status} category=${item.category ?? 'unknown'}`);
  }
  const uploads = args.filter((arg) => arg.startsWith('--upload-flow=')).map((arg) => arg.slice('--upload-flow='.length));
  const apply = args.includes('--apply');
  for (const upload of uploads) {
    const [purpose, flowId] = upload.split('=');
    if (!(FLOW_PURPOSES as readonly string[]).includes(purpose) || !flowId) {
      fail(`live: --upload-flow expects PURPOSE=<flowId> (got ${upload})`);
      continue;
    }
    const asset = loadFlowAsset(purpose as FlowPurpose);
    const request = client.uploadFlowAssetsRequest(flowId, JSON.stringify(asset.json));
    if (!apply) {
      notes.push(`live (dry run): ${client.describe(request)} with ${asset.file}; add --apply to upload`);
      continue;
    }
    const response = await client.call<{ success?: boolean; validation_errors?: unknown[] }>(request);
    const errors = response.validation_errors ?? [];
    if (errors.length > 0) fail(`live: Meta reported ${errors.length} validation error(s) for ${asset.file}: ${JSON.stringify(errors).slice(0, 1000)}`);
    else notes.push(`live: ${asset.file} uploaded to flow ${flowId} without validation errors (still unpublished)`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  for (const purpose of FLOW_PURPOSES) validateFlow(purpose);
  validateFixtures();
  const specs = validateTemplates();
  if (args.includes('--live')) await liveChecks(specs, args);
  for (const note of notes) console.log(`✓ ${note}`);
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.log(problems.length === 0 ? `\nWhatsApp assets valid (${notes.length} checks). Meta's builder/upload validation remains the final authority.` : `\n${problems.length} problem(s) found.`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}

void main();
