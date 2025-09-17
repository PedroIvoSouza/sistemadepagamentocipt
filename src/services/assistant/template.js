function resolvePath(source, path) {
  if (!source || !path) return undefined;
  return path.split('.').reduce((acc, part) => {
    if (acc == null) return undefined;
    const key = part.trim();
    if (!key) return undefined;
    return acc[key];
  }, source);
}

function applyTemplate(text, context) {
  if (typeof text !== 'string' || !text.includes('{{')) {
    return text;
  }

  return text.replace(/{{\s*([^}]+)\s*}}/g, (_match, rawKey) => {
    const value = resolvePath(context, rawKey);
    if (value === undefined || value === null) {
      return '';
    }
    if (Array.isArray(value)) {
      return value.join(', ');
    }
    return String(value);
  });
}

module.exports = {
  applyTemplate,
  resolvePath,
};
