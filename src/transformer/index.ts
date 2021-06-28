import { ModelKind, RootModel, ModelNode, ObjectField, MethodAttr } from "@src/schema/model.js";
import ts, { PropertySignature } from "typescript";
//@ts-ignore
import treefy from 'treeify';

//FIXME
const PACKAGE_NAME= '"@src/index.js"';


type TsClazzType = ts.ClassLikeDeclaration | ts.InterfaceDeclaration;

/**
 * Transforme typescript interfaces and classes to Models
 */
export function createTransformer() {
	const mapRoots: Map<string, RootModel> = new Map();
	return {
		/** Before */
		before(ctx: ts.TransformationContext): ts.Transformer<ts.SourceFile> {
			return function (sf: ts.SourceFile) {
				// Prepare root node
				const root: RootModel = {
					models: [],
					map: {},
					modelFx: undefined
				};
				mapRoots.set(sf.fileName, root);
				// Visit node
				return ts.visitNode(sf, _visitor(ctx, sf, root));
			}
		},
		/** After */
		after(ctx: ts.TransformationContext): ts.Transformer<ts.SourceFile> {
			return function (sf: ts.SourceFile) {
				function visitorCb(node: ts.Node): ts.VisitResult<ts.Node> {
					var fileName = sf.fileName;
					var t = mapRoots.get(fileName);
					if (t?.models.length) {
						return ts.visitEachChild(node, _addAst(t, ctx), ctx);
					} else {
						return node;
					}
				}
				return ts.visitNode(sf, visitorCb);
			}
		}
	}
}

/** Visitor */
function _visitor(ctx: ts.TransformationContext, sf: ts.SourceFile, root: RootModel): ts.Visitor {
	/** Add entity */
	function _addEntity(entity: ModelNode, node: ts.Node) {
		var calzzName = entity.name;
		if (!calzzName)
			throw new Error(`Expected entity name at: ${node.getStart()}`);
		if (root.map[calzzName])
			throw new Error(`Duplicated entity name: ${calzzName}`);
		root.map[calzzName] = entity;
		root.models.push(entity);
	}
	/** Visitor callback */
	function visitorCb(parentNode: ModelNode | undefined, node: ts.Node): ts.VisitResult<ts.Node> {
		// Classes & interfaces
		var currentNode: ModelNode | undefined;
		switch (node.kind) {
			case ts.SyntaxKind.ImportDeclaration:
				root.modelFx ??= _getImportedModelName(node as ts.ImportDeclaration);
				break;
			case ts.SyntaxKind.InterfaceDeclaration:
			case ts.SyntaxKind.ClassDeclaration:
			case ts.SyntaxKind.TypeLiteral:
				if (parentNode || _isTsModel(node)) {
					currentNode = {
						name: (node as TsClazzType).name?.getText(),
						kind: ModelKind.PLAIN_OBJECT,
						jsDoc: undefined,
						fields: [],
						fieldMap: {},
						isClass:	node.kind===ts.SyntaxKind.ClassDeclaration
					};
					if (parentNode)
						(parentNode as ObjectField).value = currentNode;
					else
						_addEntity(currentNode, node);
				}
				break;
			case ts.SyntaxKind.EnumDeclaration:
				console.log('----------------------------------------->> ENUM: ')
				if (_isTsModel(node)) {
					// console.log(node.getFullText());
				}
				break;
			case ts.SyntaxKind.TypeAliasDeclaration:
				console.log('----------------------------------------->> TYPE: ')
				if (_isTsModel(node)) {
					// console.log(node.getFullText());
				}
				break;
			case ts.SyntaxKind.PropertySignature:
				// Class or interface property
				if (parentNode) {
					if (parentNode.kind !== ModelKind.PLAIN_OBJECT)
						throw new Error(`Expected parent node to be interface or class, got ${ts.SyntaxKind[node.kind]} at ${node.getStart()}`);
					currentNode = {
						kind: ModelKind.FIELD,
						name: (node as PropertySignature).name.getText(),
						jsDoc: undefined,
						required: true,
						value: undefined
					};
					parentNode.fields.push(currentNode);
					parentNode.fieldMap[currentNode.name!] = currentNode;
					var i, len, childs = node.getChildren();
					for (i = 0, len = childs.length; i < len; i++) {
						visitorCb(currentNode, childs[i]);
					}
					return node;
				} else {
					console.log('---------------- found property without parent class: ', node.getText())
				}
				break;
			case ts.SyntaxKind.QuestionToken:
				// make field optional
				if (parentNode && parentNode.kind === ModelKind.FIELD) {
					parentNode.required = false;
				}
				break;
			case ts.SyntaxKind.JSDocComment:
				if (parentNode) {
					parentNode.jsDoc = node.getText().replace(/^\s*\*|^\s*\/\*\*|\s*\*\/\s*$/gm, '');
				}
				break;
			case ts.SyntaxKind.TypeReference:
			case ts.SyntaxKind.StringKeyword:
			case ts.SyntaxKind.BooleanKeyword:
			case ts.SyntaxKind.NumberKeyword:
			case ts.SyntaxKind.SymbolKeyword:
			case ts.SyntaxKind.BigIntKeyword:
				if (parentNode) {
					switch (parentNode.kind) {
						case ModelKind.FIELD:
						case ModelKind.LIST:
						case ModelKind.METHOD:
						case ModelKind.PARAM:
							parentNode.value = {
								kind: ModelKind.REF,
								name: undefined,
								jsDoc: undefined,
								value: node.getText()
							}
							break;
						default:
							console.warn(`>> Escaped ${ts.SyntaxKind[node.kind]} at ${node.getStart()}`);
					}
				}
				// string
				break
			case ts.SyntaxKind.ArrayType:
				currentNode = {
					kind: ModelKind.LIST,
					name: undefined,
					jsDoc: undefined,
					value: undefined
				}
				if (parentNode) {
					switch (parentNode.kind) {
						case ModelKind.FIELD:
						case ModelKind.LIST:
						case ModelKind.METHOD:
						case ModelKind.PARAM:
							parentNode.value = currentNode;
							break;
						default:
							console.warn(`>> Escaped ${ts.SyntaxKind[node.kind]} at ${node.getStart()}`);
					}
				}
				break;
			/** Tuple as Multipe types */
			case ts.SyntaxKind.TupleType:
				throw new Error(`Tuples are not supported, do you mean multiple types? at: ${node.getStart()}`);
			/** Method declaration */
			case ts.SyntaxKind.MethodDeclaration:
				if (parentNode) {
					if (parentNode.kind !== ModelKind.PLAIN_OBJECT)
						throw new Error(`Expected parent node to be interface or class, got ${ts.SyntaxKind[node.kind]} at ${node.getStart()}`);
					currentNode = {
						kind: ModelKind.METHOD,
						name: (node as ts.MethodDeclaration).name.getText(),
						jsDoc: undefined,
						value: undefined,
						argParam: undefined,
						[MethodAttr]: node as ts.MethodDeclaration
					}
					parentNode.fields.push(currentNode);
					parentNode.fieldMap[currentNode.name!] = currentNode;
					// Go trough childs
					var i, len, childs = node.getChildren();
					for (i = 0, len = childs.length; i < len; i++) {
						visitorCb(currentNode, childs[i]);
					}
					// Go through arg param
					var params = (node as ts.MethodDeclaration).parameters;
					if (params && params.length > 2) {
						visitorCb(currentNode, params[1]);
					}
					return node;
				}
				break;
			case ts.SyntaxKind.Parameter:
				if (parentNode) {
					if (parentNode.kind !== ModelKind.METHOD)
						throw new Error(`Enexpected param access at ${node.getStart()}`);
					currentNode = {
						kind: ModelKind.PARAM,
						name: (node as ts.ParameterDeclaration).name.getText(),
						jsDoc: undefined,
						value: undefined
					};
					parentNode.argParam = currentNode;
				}
				break;
			// default:
			// 	console.log(`${ts.SyntaxKind[node.kind]}: ${node.getFullText()}`)
		}
		return ts.visitEachChild(node, visitorCb.bind(null, currentNode), ctx);
	}
	/** Return */
	return visitorCb.bind(null, undefined);
}

/** Check has not "@tsmodel" flag */
function _isTsModel(node: ts.Node): boolean {
	var childs = node.getChildren();
	var i, len;
	for (i = 0, len = childs.length; i < len; i++) {
		const childNode = childs[i];
		if (ts.isJSDoc(childNode)) {
			var childNodes = childNode.getChildren();
			for (let j = 0, jLen = childNodes.length; j < jLen; j++) {
				if (childNodes[j].getFullText().includes('@tsmodel')) { return true }
			}
		}
	}
	return false;
}

function _getImportedModelName(node: ts.ImportDeclaration): string | undefined {
	var i, len, childs = node.getChildren(), child;
	var isModelImport = false;
	var strImport;
	rtLoop: for (i = 0, len = childs.length; i < len; ++i) {
		child = childs[i];
		switch (child.kind) {
			case ts.SyntaxKind.ImportClause:
				strImport = child.getText();
				break;
			case ts.SyntaxKind.StringLiteral:
				if (child.getText() === PACKAGE_NAME) {
					isModelImport = true;
					break rtLoop;
				}
				break;
		}
	}
	var m;
	if (isModelImport && strImport && (m = strImport.match(/\bModel\b(?: as (\w+))?/))) {
		return m[1] || m[0];
	}
}

/** Apply AST visitor */
function _addAst(root: RootModel, ctx: ts.TransformationContext) {
	function vst(node: ts.Node): ts.Node {
		switch (node.kind) {
			case ts.SyntaxKind.NewExpression:
				if (node.getChildAt(1).getText() === root.modelFx) {
					// convert
					return ctx.factory.updateNewExpression(
						node as ts.NewExpression,
						(node as ts.NewExpression).expression,
						(node as ts.NewExpression).typeArguments,
						[_serializeAST(root, ctx)],
					)
				}
				break;
		}
		return ts.visitEachChild(node, vst, ctx);
	}
	return vst;
}

/** Serialize AST */
function _serializeAST(root: RootModel, ctx: ts.TransformationContext): ts.Expression{
	const factory= ctx.factory;
	var fields:ts.Expression[]= []
	const rootNode= factory.createObjectLiteralExpression([
		//Models
		factory.createPropertyAssignment(
			factory.createIdentifier("models"),
			factory.createArrayLiteralExpression( fields, false )
		),
	]);
	const queue:ts.Expression[][]= [fields];
	const nodeQueue= [root.models];
	//-------
	var i, len, node, prop, props= root.models;
	for(i=0, len= queue.length; i<len; ++i){
		prop= queue[i];
	}
	return rootNode;
	//return ctx.factory.createIdentifier(JSON.stringify(root));
}