import { createMacro, MacroHandler } from "babel-plugin-macros";
import { NodePath } from "@babel/core";
import * as path from "path";
import * as fs from "fs";
import * as t from "@babel/types";

export type Dependency = number | string | { uniqueId: string; }

function addImportStatement(importName: string, importPath: string, isDefault: boolean, nodePath: NodePath) {
  const programPath = nodePath.findParent((path) => path.isProgram());
  if (!programPath || !t.isProgram(programPath.node)) {
    throw new Error("Could not find program path");
  }

  const existingImportDeclaration = programPath.node.body.find(
    p => t.isImportDeclaration(p) && p.source.value === importPath
  );

  if (!existingImportDeclaration) {
    let importDeclarator;

    if(isDefault) {
      importDeclarator = t.importDefaultSpecifier(t.identifier(importName));
    } else {
      importDeclarator = t.importSpecifier(t.identifier(importName), t.identifier(importName));
    }

    const newImportDeclaration = t.importDeclaration(
      [importDeclarator],
      t.stringLiteral(importPath),
    );      
    programPath.node.body.unshift(newImportDeclaration);
  }
}

interface PluginOptions {
  useSSRComputation: {
    side: 'client' | 'server';
  };
}

export type Options = {
  webpackChunkName?: string;
}

type PrimitiveObjectProperty = t.ObjectProperty & {
  key: t.Identifier | t.StringLiteral;
  value: t.StringLiteral | t.BooleanLiteral | t.NumericLiteral;
}

function isPrimitiveObjectProperty(property: t.ObjectProperty | t.ObjectMethod | t.SpreadElement): property is PrimitiveObjectProperty {
  return t.isObjectProperty(property) &&
         (t.isIdentifier(property.key) || t.isStringLiteral(property.key)) &&
         (t.isStringLiteral(property.value) || t.isBooleanLiteral(property.value) || t.isNumericLiteral(property.value));
}

function parseToOptions(optionsNode: t.ObjectExpression): Options {
  if (optionsNode.properties.length === 0) {
    return {};
  }

  const options = {};
  for (const property of optionsNode.properties) {
    if (!isPrimitiveObjectProperty(property)) {
      throw new Error("Options object can only contain properties with primitive values.")
    }

    const key = t.isStringLiteral(property.key) ? property.key.value : property.key.name;
    options[key] = property.value.value;
  }
  
  return options;
}

const macro: MacroHandler = ({ references, state }) => {
  const currentFilename = state.file.opts.filename;
  if (!currentFilename) {
    throw new Error("useSSRComputation is called without filename");
  }

  const pluginOptions = state.opts as PluginOptions;

  const opts = pluginOptions?.useSSRComputation;
  if (!opts || (opts.side !== 'client' && opts.side !== 'server')) {
    throw new Error(`The "side" option must be specified in babel-plugin-macros config in babel.config.js:
      plugins: [
        [
          "macros",
          {
            useSSRComputation: {
              isSSRBundle ? "server" : "client",
            },
          },  

      ]
    `);

  }
  const side : 'client' | 'server' = opts?.side;

  (references.useSSRComputation || []).map((nodePath: NodePath) => {
    const parent = nodePath.parent;
    if (t.isCallExpression(parent)) {
      if (parent.arguments.length < 2) { 
        throw new Error("useSSRComputation must be called with at least two arguments: a path to a .ssr-computation.js file containing the definition of the funciton and array of dependencies.");
      }

      if (parent.arguments.length > 3) {
        throw new Error("useSSRComputation must be called with at most three arguments: a path to a .ssr-computation.js file containing the definition of the funciton, array of dependencies and options object.");
      }
  
      const filenameNode = parent.arguments.shift();
      const optionsNode = parent.arguments.length === 2 ? parent.arguments.pop() : t.objectExpression([]);

      if (!t.isStringLiteral(filenameNode)) {
        throw new Error("The first argument must be a path to an existing ts file.");
      }

      // Check and parse options
      if (!t.isObjectExpression(optionsNode)) {
        throw new Error("The third argument must be an options object.");
      }
      const options = parseToOptions(optionsNode);

      const webpackChunkName = (options.webpackChunkName ? options.webpackChunkName : 'default') + '-ssr-computations';

      const absolutePath = path.resolve(
        path.dirname(currentFilename),
        filenameNode.value,
      );

      const extensions = ['.ts', '.js', '.tsx', '.jsx'];
      if (!extensions.some(extension => fs.existsSync(absolutePath + extension))) {
        throw new Error(`The file ${filenameNode}(.js/.ts/.jsx/.tsx) does not exist.`);
      }

      const useSSRComputationFunctionName = `useSSRComputation_${side.charAt(0).toUpperCase() + side.slice(1)}`; 
      parent.callee = t.identifier(useSSRComputationFunctionName);
      addImportStatement(useSSRComputationFunctionName, `use-ssr-computation.runtime/lib/${useSSRComputationFunctionName}`, true, nodePath);
      
      if (side === 'server')
      {
        let importedFunctionName = filenameNode.value;
        const delimeter = '.ssr-computation';
        if (!importedFunctionName.endsWith('.ssr-computation')) {
          throw new Error(`The file ${importedFunctionName} must have the extension ${delimeter} to be used in useSSRComputation`);
        }

        importedFunctionName = importedFunctionName.replace(delimeter, '');
        importedFunctionName = importedFunctionName.replace(/[^a-zA-Z0-9]/g, '_');

        addImportStatement(importedFunctionName, filenameNode.value, true, nodePath);

        const identifier = t.identifier(importedFunctionName);
        parent.arguments.unshift(identifier);
      } else {
        const importString = t.stringLiteral(filenameNode.value);
        importString.leadingComments = [
          {
            type: 'CommentBlock',
            value: ` webpackChunkName: "${webpackChunkName}" `
          }
        ];

        const dynamicImportExpression = t.arrowFunctionExpression([],
          t.callExpression(t.import(), [importString])
        );
        parent.arguments.unshift(dynamicImportExpression);
      }

      const relativePathToCwd = path.relative(process.cwd(), absolutePath);
      parent.arguments.push(t.stringLiteral(relativePathToCwd));
    }
  });

};

export const useSSRComputation: (filename: string, dependencies: Dependency[], options: Options) => any = null as any;

export default createMacro(macro, {
  configName: "useSSRComputation",
});
