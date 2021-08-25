import { FormatedInputNode, FormatedInputObject, FormatedOutputNode, FormatedOutputObject } from "./formater-model";
import { Field, FieldType, InputField, List, ModelKind, Node, OutputField, Param, PlainObject, Reference } from "../parser/model";
import ts from "typescript";
import { warn } from "@src/utils/log";

/** Format parsed results to generate usable model */
export function format(root: Map<string, Node>): FormatReponse {
	const result: FormatReponse={
		input:	new Map(),
		output:	new Map()
	};
	const inputMap= result.input;
	const outputMap= result.output;
	/** Resolved generics */
	const resovledGenerics: Map<string, PlainObject>= new Map();
	//* Go through nodes
	var rootQueue= Array.from(root.entries());
	var rootQueueIdx= 0;
	while(rootQueueIdx < rootQueue.length){
		let [nodeName, node]= rootQueue[rootQueueIdx++];
		switch(node.kind){
			case ModelKind.BASIC_SCALAR:
			case ModelKind.SCALAR:
			case ModelKind.ENUM:
			case ModelKind.UNION:
				inputMap.set(nodeName, node);
				outputMap.set(nodeName, node);
				break;
			case ModelKind.PLAIN_OBJECT:
				// Ignore generic objects
				if(node.generics!=null) break;
				//* Resolve fields
				let inputFields: FormatedInputObject['fields']= [];
				let outputFields: FormatedOutputObject['fields']= [];
				//* Inherited classes (used for sorting fields)
				let inherited: string[]= [];
				if(node.inherit!=null){
					for(let i=0, cl=node.inherit, len=cl.length; i<len; ++i){
						inherited.push(cl[i].name);
					}
				}
				//* Resolve fields
				let resolvedFields: ResolvedFieldInterface[]= [];
				node.visibleFields.forEach(function(v, fieldName){
					var f= (node as PlainObject).fields.get(fieldName);
					var inheritedFrom: string|undefined;
					if(f==null){
						let obj= root.get(v.className) as PlainObject;
						if(obj==null) throw new Error(`Missing entity "${v.className}" inherited to "${node.name}.${fieldName}" at ${(node as PlainObject).fileName}`);
						f= obj.fields.get(fieldName);
						inheritedFrom= `${obj.name}.${fieldName}`;
						if(f==null){
							warn(`FORMAT>> Ignored field "${inheritedFrom}" super of "${node.name}.${fieldName}" at ${obj.fileName}`);
							return;
						}
					}
					// Flags
					var isRequired= !(v.flags & ts.SymbolFlags.Optional);
					resolvedFields.push({
						field: 			f,
						requried:		isRequired,
						inheritedFrom:	inheritedFrom,
						index:			f.idx,
						className:		f.className!
					})
				});
				//* Sort fields
				if(inherited.length!=0){
					resolvedFields.sort(function(a,b){
						if(a.className===b.className) return a.index - b.index;
						else if(a.className === null) return 1;
						else if(b.className === null) return -1;
						else return inherited.indexOf(b.className) - inherited.indexOf(a.className)
					});
				}
				//* Load fields
				for(let i=0, len= resolvedFields.length; i<len; ++i){
					let {field: f, inheritedFrom, className, requried: isRequired}= resolvedFields[i];
					// Input field
					if(f.input!=null){
						let fin= f.input;
						inputFields.push({
							kind:			fin.kind,
							alias:			f.alias,
							name:			fin.name,
							id:				fin.id,
							deprecated:		fin.deprecated,
							defaultValue:	fin.defaultValue,
							jsDoc:			inheritedFrom==null? fin.jsDoc : `${fin.jsDoc}\n@inherit-from ${inheritedFrom}`,
							required:		isRequired,
							type:			_resolveType(fin.type, fin, className, inheritedFrom),
							asserts:		fin.asserts,
							validate:		fin.validate
						});
					}
					if(f.output!=null){
						let fout= f.output;
						outputFields.push({
							kind:			fout.kind,
							name:			fout.name,
							alias:			fout.alias,
							id:				fout.id,
							deprecated:		fout.deprecated,
							jsDoc:			inheritedFrom==null? fout.jsDoc : `${fout.jsDoc}\n@inherit-from ${inheritedFrom}`,
							method:			fout.method,
							param:			fout.param==null? undefined : _resolveType(fout.param, fout, className, inheritedFrom),
							required:		isRequired,
							type:			_resolveType(fout.type, fout, className, inheritedFrom)
						});
					}
				}
				//* Entities
				if(inputFields.length!==0){
					// Create object
					let formatedInputObj: FormatedInputObject={
						kind:		ModelKind.PLAIN_OBJECT,
						name:		node.name,
						escapedName: node.escapedName,
						id:			node.id,
						deprecated:	node.deprecated,
						jsDoc:		node.jsDoc,
						fields:		inputFields
					};
					inputMap.set(nodeName, formatedInputObj);
				}
				if(outputFields.length!==0){
					let formatedOutputObj: FormatedOutputObject= {
						kind:		ModelKind.PLAIN_OBJECT,
						name:		node.name,
						escapedName: node.escapedName,
						id:			node.id,
						deprecated:	node.deprecated,
						jsDoc:		node.jsDoc,
						fields:		outputFields
					};
					outputMap.set(nodeName, formatedOutputObj);
				}
				break;
			default:
				throw new Error(`Unknown kind: ${ModelKind[node.kind]}`);
		}
	}
	return result;

	/** Resolve generic types */
	function _resolveType<T extends FieldType|Param>(type: T, field: InputField|OutputField, className: string, inhiretedFrom: string|undefined): T {
		// Check if field has generic type
		var p: FieldType|Param= type;
		while(p.kind!==ModelKind.REF) p= p.type;
		if(p.params== null) return type;
		// Resolve generic reference
		var q:(FieldType|Param)[]=[];
		p= type;
		while(p.kind !== ModelKind.REF){
			q.push(p);
			p= p.type;
		}
		var resolvedRef:FieldType|Param= _resolveGeneric(p, field, className, inhiretedFrom);
		if(q.length!==0){
			q.reverse();
			for(let i=0, len= q.length; i<len; ++i){
				resolvedRef= {...q[i], type: resolvedRef} as List|Param;
			}
		}
		return resolvedRef as T;
	}
	/** Resolve generic type */
	function _resolveGeneric(ref: Reference, field: InputField|OutputField, className: string, inhiretedFrom: string|undefined): Reference{
		var refNode= root.get(ref.name);
		if(refNode==null)
			throw new Error(`Missing generic entity "${ref.name}" referenced by "${inhiretedFrom??className}.${field.name}" at ${field.fileName}`);
		if(refNode.kind!==ModelKind.PLAIN_OBJECT)
			throw new Error(`Expected PlainObject as reference of generic "${inhiretedFrom??className}.${field.name}". Got "${ModelKind[refNode.kind]}" at ${field.fileName}`)
		var escapedName= _getGenericEscapedName(ref);
		if(root.has(escapedName))
			throw new Error(`Found entity "${escapedName}" witch equals to the escaped name of generic: ${_getGenericName(ref)} at ${ref.fileName}`);
		var gEntity= resovledGenerics.get(escapedName);
		if(gEntity==null){
			let name= _getGenericName(ref);
			gEntity= {
				kind:			ModelKind.PLAIN_OBJECT,
				name:			name,
				escapedName:	escapedName,
				deprecated:		refNode.deprecated,
				jsDoc:			`@Generic ${name}${ refNode.jsDoc==null? '': "\n"+refNode.jsDoc }`,
				fields:			_resolveGenericFields(refNode, ref.params!),
				fileName:		refNode.fileName,
				generics:		undefined,
				id:				refNode.id,
				inherit:		refNode.inherit,
				ownedFields:	refNode.ownedFields,
				visibleFields:	refNode.visibleFields
			};
			resovledGenerics.set(escapedName, gEntity);
			rootQueue.push([escapedName, gEntity]);
		}
		return {
			kind:		ModelKind.REF,
			fileName:	ref.fileName,
			name:		escapedName,
			params:		undefined
		}
	}
}


/** Format response */
export interface FormatReponse{
	input:	Map<string, FormatedInputNode>
	output:	Map<string, FormatedOutputNode>
}

/** Resolved fields */
interface ResolvedFieldInterface{
	field: 			Field,
	requried:		boolean,
	inheritedFrom:	string|undefined,
	index:			number,
	className:		string
}

// Get generic escpated name
function _getGenericEscapedName(ref: FieldType): string{
	switch(ref.kind){
		case ModelKind.REF:
			if(ref.params==null) return ref.name;
			else return `${ref.name}_${ref.params.map(_getGenericEscapedName).join('_')}`;
		case ModelKind.LIST:
			return '_'+_getGenericEscapedName(ref.type);
		default:
			let t:never= ref;
			throw new Error('Unsupported kind');
	}
}
// Get generic name
function _getGenericName(ref: FieldType): string{
	switch(ref.kind){
		case ModelKind.REF:
			if(ref.params==null) return ref.name;
			else return `${ref.name}<${ref.params.map(_getGenericName).join(', ')}>`;
		case ModelKind.LIST:
			return _getGenericName(ref.type)+'[]';
		default:
			let t:never= ref;
			throw new Error('Unsupported kind');
	}
}

function _resolveGenericFields(refNode: PlainObject, params: FieldType[]): Map<string, Field> {
	var fields: Map<string, Field>= new Map();
	// Map param 
	//FIXME resolve params
	return fields;
}