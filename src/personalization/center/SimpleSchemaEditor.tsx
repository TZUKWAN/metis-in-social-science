import { useState } from 'react';
import {
  buildInvalidSimpleSchemaDraft,
  buildSimpleSchema,
  buildSimpleSchemaReplacementDraft,
  isSimpleSchemaRowsValid,
  isStrictEmptySimpleSchema,
  readInvalidSimpleSchemaDraft,
  readSimpleSchema,
  readSimpleSchemaReplacementDraft,
  SIMPLE_SCHEMA_TYPE_OPTIONS,
  type SimpleSchemaField,
  type SimpleSchemaFieldType,
} from './shared.js';

export function SimpleSchemaEditor({
  label,
  value,
  onChange,
  onValidityChange,
  zh,
}: {
  label: string;
  value: Record<string, unknown> | null;
  onChange: (value: Record<string, unknown> | null) => void;
  onValidityChange: (valid: boolean) => void;
  zh: boolean;
}) {
  const parsed = readSimpleSchema(value);
  const invalidDraft = readInvalidSimpleSchemaDraft(value);
  const restoredReplacement = readSimpleSchemaReplacementDraft(value);
  const [rows, setRows] = useState<SimpleSchemaField[]>(parsed ?? []);
  const [unsupported, setUnsupported] = useState(parsed === null);
  const [replacementOriginal, setReplacementOriginal] = useState<Record<string, unknown> | null>(
    restoredReplacement?.original ?? null,
  );
  const [replacementMode, setReplacementMode] = useState(restoredReplacement !== null);
  const [preserveEmptyObject, setPreserveEmptyObject] = useState(
    invalidDraft?.preserveEmptyObject
      ?? restoredReplacement?.preserveEmptyObject
      ?? isStrictEmptySimpleSchema(value),
  );
  const [error, setError] = useState(invalidDraft
    ? (zh ? '字段名必须唯一，以字母或下划线开头。' : 'Field names must be unique and start with a letter or underscore.')
    : '');

  const commit = (next: SimpleSchemaField[]) => {
    setRows(next);
    const names = next.map((row) => row.name.trim());
    const valid = isSimpleSchemaRowsValid(next);
    if (!valid) {
      setError(zh ? '字段名必须唯一，以字母或下划线开头。' : 'Field names must be unique and start with a letter or underscore.');
      onChange(replacementMode && replacementOriginal
        ? buildSimpleSchemaReplacementDraft(replacementOriginal, next, preserveEmptyObject)
        : buildInvalidSimpleSchemaDraft(next, preserveEmptyObject));
      onValidityChange(false);
      return;
    }
    setError('');
    const normalizedRows = next.map((row, index) => ({ ...row, name: names[index]! }));
    if (replacementMode && replacementOriginal) {
      onChange(buildSimpleSchemaReplacementDraft(replacementOriginal, normalizedRows, preserveEmptyObject));
      onValidityChange(false);
    } else {
      onChange(buildSimpleSchema(normalizedRows, preserveEmptyObject));
      onValidityChange(true);
    }
  };

  if (unsupported) return <fieldset className="personalization-schema-editor">
    <legend>{label}</legend>
    <div className="personalization-boundary"><strong>{zh ? '已保留现有复杂结构' : 'Existing advanced schema preserved'}</strong><span>{zh ? '此结构超出可视化字段编辑器范围。只有明确选择替换时才会清空。' : 'This schema is more complex than the visual field editor. It remains unchanged unless you explicitly replace it.'}</span></div>
    <button type="button" onClick={() => {
      if (!value) return;
      setUnsupported(false);
      setRows([]);
      setError('');
      setReplacementOriginal(value);
      setReplacementMode(true);
      setPreserveEmptyObject(true);
      onChange(buildSimpleSchemaReplacementDraft(value, [], true));
      onValidityChange(false);
    }}>{zh ? '替换为可视化字段' : 'Replace with visual fields'}</button>
  </fieldset>;

  return <fieldset className="personalization-schema-editor">
    <legend>{label}</legend>
    {replacementMode && replacementOriginal && <div className="personalization-boundary">
      <strong>{zh ? '可视化替换尚未应用' : 'Visual replacement not applied'}</strong>
      <span>{zh ? '原始高级结构仍可恢复。应用替换后才能保存定义。' : 'The original advanced schema remains recoverable. Apply the replacement before saving the definition.'}</span>
      <div className="personalization-actions">
        <button type="button" onClick={() => {
          setRows([]);
          setError('');
          setReplacementMode(false);
          setReplacementOriginal(null);
          setUnsupported(true);
          setPreserveEmptyObject(false);
          onChange(replacementOriginal);
          onValidityChange(true);
        }}>{zh ? '取消替换' : 'Cancel replacement'}</button>
        <button type="button" disabled={!isSimpleSchemaRowsValid(rows)} onClick={() => {
          const names = rows.map((row) => row.name.trim());
          const normalizedRows = rows.map((row, index) => ({ ...row, name: names[index]! }));
          setRows(normalizedRows);
          setReplacementMode(false);
          setReplacementOriginal(null);
          setError('');
          onChange(buildSimpleSchema(normalizedRows, preserveEmptyObject));
          onValidityChange(true);
        }}>{zh ? '应用可视化替换' : 'Apply visual replacement'}</button>
      </div>
    </div>}
    <p>{zh ? '逐项定义字段；Metis 会生成严格结构，不需要直接编写 JSON。' : 'Define fields one by one. Metis builds a strict schema without raw JSON editing.'}</p>
    <div className="personalization-schema-fields">
      {rows.map((row, index) => <div className="personalization-schema-field" key={`schema-field-${index}`}>
        <label><span>{zh ? '字段名' : 'Field name'}</span><input value={row.name} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} /></label>
        <label><span>{zh ? '类型' : 'Type'}</span><select value={row.type} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as SimpleSchemaFieldType } : item))}>{SIMPLE_SCHEMA_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option[zh ? 'zh' : 'en']}</option>)}</select></label>
        <label className="personalization-schema-field__description"><span>{zh ? '说明' : 'Description'}</span><input value={row.description} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item))} /></label>
        <label className="personalization-schema-field__required"><input type="checkbox" checked={row.required} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item))} />{zh ? '必填' : 'Required'}</label>
        <button type="button" onClick={() => commit(rows.filter((_item, itemIndex) => itemIndex !== index))}>{zh ? '删除' : 'Remove'}</button>
      </div>)}
    </div>
    {error && <p className="personalization-schema-error" role="alert">{error}</p>}
    <button type="button" onClick={() => {
      let ordinal = rows.length + 1;
      while (rows.some((row) => row.name === `field_${ordinal}`)) ordinal += 1;
      commit([...rows, { name: `field_${ordinal}`, type: 'string', description: '', required: false }]);
    }}>{zh ? '添加字段' : 'Add field'}</button>
  </fieldset>;
}
