const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'src');
const templatePath = path.join(sourceRoot, 'index.template.html');
const outputPath = path.join(sourceRoot, 'index.html');
const includePattern = /<!--\s*@include\((.+?)\)\s*-->/g;

function resolveIncludes(html, baseDir) {
  return html.replace(includePattern, (_match, includePath) => {
    const resolvedPath = path.resolve(baseDir, includePath.trim());
    const includedHtml = fs.readFileSync(resolvedPath, 'utf8');
    return resolveIncludes(includedHtml, path.dirname(resolvedPath));
  });
}

function buildHtml() {
  const templateHtml = fs.readFileSync(templatePath, 'utf8');
  const outputHtml = resolveIncludes(templateHtml, sourceRoot);
  fs.writeFileSync(outputPath, outputHtml);
}

if (require.main === module) {
  buildHtml();
}

module.exports = {
  buildHtml,
  resolveIncludes,
};
