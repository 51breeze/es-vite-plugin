const {readFileSync}  = require('fs');
const Compiler = require("easescript/lib/core/Compiler");
const Diagnostic = require("easescript/lib/core/Diagnostic");
const rollupPluginUtils = require('rollup-pluginutils');
const path = require('path');
const vuePlugin=require("@vitejs/plugin-vue");
const {compileStyle}=require("vue/compiler-sfc");
const compiler = Compiler.compiler();
const EXPORT_HELPER_ID = "\0plugin-vue:export-helper";
const helperCode = `
export default (sfc, props) => {
  const target = sfc.__vccOpts || sfc;
  for (const [key, val] of props) {
    target[key] = val;
  }
  return sfc;
}
`;

const {createHash} = require('node:crypto');

const allowPreprocessLangs =['less', 'sass','scss','styl','stylus'];
const directRequestRE = /(?:\?|&)direct\b/;
const styleRequestRE = /(?:\?|&)type=style\b/;
const removeNewlineRE = /[\r\n\t]/g;
var hasCrossPlugin = false;

function getBuildPlugin(config={}){
    const load = ()=>{
        if(config.plugin && typeof config.plugin==='function'){
            return config.plugin;
        }else if(config.name){
            return require(config.name)
        }else{
            throw new Error('Plugin name invalid')
        }
    }
    const plugin = load();
    return plugin(config.options)
}

function errorHandle(context, compilation){
    if( !Array.isArray(compilation.errors) )return;
    return compilation.errors.filter( error=>{
        if(error.kind === Diagnostic.ERROR){
            return true;
        }else{
            context.warn( error.toString() )
            return false;
        }
    }).map( item=>item.toString() );
}

function parseResource(id) {
    const [resourcePath, rawQuery] = id.split(`?`, 2);
    const query = Object.fromEntries(new URLSearchParams(rawQuery));
    if (query.vue != null) {
        query.vue = true;
    }
    return {
        resourcePath,
        resource:id,
        query
    };
}

function getSections(compilation){
    let jsx = '';
    let style = '';
    let script = compilation.source;
    let offset = 0;
    let hasStyleScoped = false;
    const substring = (stack)=>{
        let len = stack.node.end - stack.node.start;
        let start = stack.node.start - offset;
        let end = stack.node.end - offset;
        script = script.substring(0, start) + script.substring(end, script.length);
        offset+=len;
    }
    compilation.jsxElements.forEach(stack=>{
        jsx+=stack.raw();
        substring(stack);
    });
    compilation.jsxStyles.forEach(stack=>{
        style+=stack.raw();
        substring(stack);
        const scoped = stack.openingElement.attributes.find(attr=>attr.name.value() === 'scoped');
        if(scoped){
            const styleScoped = scoped.value ? Boolean(scoped.value.value()) : true;
            if(!hasStyleScoped){
                hasStyleScoped  = styleScoped;
            }
            style+=`/*[scoped=${String(styleScoped)}]*/`;
        }
    });
    style = style.replace(removeNewlineRE, '');
    jsx   = jsx.replace(removeNewlineRE, '');
    script = script.replace(removeNewlineRE, '');
    return {jsx, style, script, hasStyleScoped};
}

function createFilter(include = [/\.(es|ease)(\?|$)/i], exclude = []) {
    const filter = rollupPluginUtils.createFilter(include, exclude);
    return id => filter(id);
}

function makePlugins(rawPlugins, options, cache, fsWatcher, getContext){
    var plugins = null;
    if( Array.isArray(rawPlugins) && rawPlugins.length > 0 ){
        plugins = rawPlugins.map( plugin=>getBuildPlugin(plugin) );
        const watchedRecords = new WeakSet();
        const addWatch = (compilation)=>{
            if(fsWatcher && !watchedRecords.has(compilation)){
                watchedRecords.add(compilation)
                fsWatcher.add(compilation.file).on('change',async (file)=>{
                    const compilation = compiler.getCompilationByFile(file);
                    if(compilation){
                        build(compilation, true);
                    }
                });
            }
        }
        const build = async (compilation, changed)=>{
            if(!compilation || compilation.isDescriptionType){
                return false;
            }
            if(changed){
                const code = readFileSync(compilation.file,"utf-8").toString();
                if( !compilation.isValid(code) ){
                    compilation.clear();
                    compilation.createStack(code);
                }else{
                    return true;
                }
            }
            await compilation.ready();
            let errors = errorHandle(getContext(), compilation);
            if(errors && errors.length>0){
                console.error(errors.join("\n"));
                return;
            }
            plugins.forEach( async plugin=>{
                if(compiler.isPluginInContext(plugin , compilation)){
                    addWatch(compilation)
                    try{
                        if(changed){
                            await plugin.build(compilation);
                        }else{
                            await plugin.run(compilation)
                        }
                    }catch(e){
                        console.error(e)
                    }
                }
            });
            return true
        }
        compiler.on('onParseDone', build);
    }
    
    return plugins
}

function getHash(text) {
    return createHash("sha256").update(text).digest("hex").substring(0, 8);
}

function getHotReplaceCode(compilation, code, records={}){
    const prev = records.prev;
    const last = records.last;
    const prerender = prev && last && prev.script === last.script && prev.style === last.style && prev.jsx !== last.jsx;

    if(!compilation.modules.size || compilation.isDescriptionType){
        return code;
    }

    code = code.replace(/\bexport\s+default\s+/, 'const __$exports__ = ')

    const items = [
        code,
        `export default __$exports__;`
    ];

    if( prerender ){
        items.push(`export const __$$prerender_$only__ = true;`)
    }

    const id = getHash( compilation.file );

    items.push(`if(import.meta.hot){`,
    `  __$exports__.__vccOpts.__hmrId = "${id}";`,
    `  __VUE_HMR_RUNTIME__.createRecord("${id}", __$exports__);`,
    `  import.meta.hot.accept(mod => {`,
    `  if (!mod) return`,
    `  const {default: updated, __$$prerender_$only__ } = mod`,
    `  console.log(updated.prototype.render);`,
    `  if (__$$prerender_$only__) {`,
    `    __VUE_HMR_RUNTIME__.rerender("${id}", updated.prototype.render)`,
    `  } else {`,
    `    __VUE_HMR_RUNTIME__.reload("${id}", updated)`,
    `  }`,
    `  });`,
    `}`)

    return items.join('\n')
}

function EsPlugin(options={}){
    const getContext = ()=>pluginContext;
    const filter = createFilter(options.include, options.exclude);
    const mainPlugin = getBuildPlugin(options.builder)
    const cache = new Map();
    const fsWatcher = options.watch ? compiler.createWatcher() : null;
    const plugins = makePlugins(options.plugins, options, cache, fsWatcher, getContext);
    const rawOpts = mainPlugin.options || {};
    const isProduction = rawOpts.mode === 'production' || process.env.NODE_ENV === 'production';
    const hotReload = !!rawOpts.hot;
    const hotRecords = hotReload ? new Map() : null;
    if(plugins){
        hasCrossPlugin = true;
    }

    async function getCode(resourcePath, resource=null, query={}){
        if(!resource)resource = resourcePath;
        const compilation = await compiler.ready(resourcePath)
        if(compilation){
            cache.set(compilation, compilation.source);
            if(hasCrossPlugin && !compiler.isPluginInContext(mainPlugin , compilation) ){
                return {
                    code:`export default null;/*Removed "${compilation.file}" file that is not in plugin scope the "${mainPlugin.name}". */`,
                    map:null
                };
            }

            let buildGraph = null;
            try{
                if(query.id && query.type == null){
                    buildGraph = await mainPlugin.build(compilation, query.id);
                }else{
                    buildGraph = await mainPlugin.build(compilation);
                }
            }catch(e){
                getContext().error(e);
                return
            }

            if(!buildGraph){
                getContext().error(`Build error no result. on the "${resource}"`);
                return;
            }
                        
            if( query.macro && typeof mainPlugin.getMacros ==='function'){
                const code = await mainPlugin.getMacros(compilation) || '//Not found defined macro.'
                return {code:code, map:null};
            }

            let content = null;
            let sourcemap =  null;
           
            if(query.type === 'style' || query.type === 'embedAssets'){
                let asset = buildGraph.findAsset(asset=>asset.id == query.index);
                if(!asset){
                    getContext().error(`Not found style by "${query.index}". on the "${resource}"`)
                    return;
                }
                content = asset.code;
                sourcemap = asset.sourcemap;
                if(query.type === 'embedAssets'){
                    content = `export default ${JSON.stringify(content)}`;
                }else if(query.type === 'style' && compileStyle){
                    const lang = query.lang;
                    const scopePrefix = builder.options?.vue?.scopePrefix || "";
                    const scopeId = query.scoped ? (scopePrefix + query.scoped) : '';
                    const result = compileStyle({
                        source:content,
                        filename:file,
                        scoped:!!scopeId,
                        inMap:sourcemap,
                        id:scopeId,
                        preprocessLang:allowPreprocessLangs.includes(lang) ? lang :  undefined,
                        isProd:isProduction
                    });
                    if(result.errors && result.errors.length>0){
                        getContext().error(
                            result.errors.map( err=>{
                                return err.message + '\n' + err.stack;
                            }).join("\n")
                        );
                        return;
                    }
                    content =result.code;
                    sourcemap = result.map;
                }
                return {code:content, map:sourcemap};
            }else{
                content = buildGraph.code;
                sourcemap =  buildGraph.sourcemap;
                if(query.src){
                    return {
                        code:content,
                        map:sourcemap
                    }
                }
                if(!content){
                    getContext().error(`Build error code is empty. on the "${resource}"`);
                    return;
                }
            }
            
        }else{
           throw new Error(`'${resource}' is not exists.`)
        }
    }

    let pluginContext = null;
    const Plugin = {
        name: 'vite:easescript',
        async handleHotUpdate(ctx) {
            let {file, modules, read} = ctx;
            if(!filter(file) || !hotRecords)return;
            const compilation = await compiler.createCompilation(file);
            if(compilation){
                const code = await read();
                if(cache.get(compilation) !== code){
                    cache.set(compilation, code);
                    const oldSection = getSections(compilation);
                    await compilation.ready();
                    if(compilation.stack){
                        const changed = new Set();
                        const newSection = getSections(compilation);
                        let hasStyleChanged = false;
                        hotRecords.set(compilation, {prev:oldSection, last:newSection});
                        modules.forEach( mod=>{
                            if(directRequestRE.test(mod.url))return;
                            if(styleRequestRE.test(mod.url)){
                                if(oldSection.style !== newSection.style){
                                    changed.add(mod);
                                    hasStyleChanged = true;
                                }
                            }else if(oldSection.script !== newSection.script || oldSection.jsx !== newSection.jsx){
                                changed.add(mod);
                            }
                        });
                        return Array.from(changed.values());
                    }else{
                        compilation.errors.forEach( error=>{
                            if(error.kind === Diagnostic.ERROR){
                                console.error( error.toString() )
                            }else{
                                console.warn( error.toString() )
                            }
                        });
                    }
                }
                return [];
            }
        },
        config(config) {
            if(!mainPlugin.options.ssr){
                mainPlugin.options.ssr = config.build?.ssr;
            }
            return config;
        },
        configResolved(config){},
        configureServer(server){},
        buildStart(){
            pluginContext = this;
        },
        async resolveId(id, ...args){
            if( filter(id) ){
                if( !path.isAbsolute(id) ){
                    const className = compiler.getFileClassName(id, true);
                    const desc = Namespace.globals.get(className);
                    if(desc && desc.compilation){
                        return desc.compilation.file;
                    }
                }
                return id;
            }
        },
        getDoucmentRoutes(file){
            if( !filter(file) || mainPlugin.name !=='es-nuxt' ) return null;
            return new Promise( async(resolve,reject)=>{
                const compilation = await compiler.ready(file);
                if( compilation ){
                    mainPlugin.build(compilation, (error,builder)=>{
                        const errors = errorHandle(this, compilation);
                        if( error ){
                            errors.push( error.toString() );
                        }
                        if( errors && errors.length > 0 ){
                            reject( new Error( errors.join("\r\n") ) );
                        }else{
                            let module = compilation.mainModule;
                            let routes = [];
                            let items = [];
                            if(!module && compilation.modules.size > 0){
                                items = Array.from(compilation.modules.values()).filter( m=>m.isClass && !m.isDescriptionType )
                            }else{
                                items.push(module);
                            }
                            items.forEach( module=>{
                                const res = builder.getModuleRoutes(module);
                                if( res ){
                                    routes.push( ...res )
                                }
                            });
                            resolve(routes);
                        }
                    })
                }else{
                    reject( new Error( `"${file}" is not exists.` ) );
                }
            });
        },

        load(id, opt){
            //fix: use-empty-values, config-provider 这两个组件存在相互依赖，在打包构建时有问题
            if(id && id.includes('element-plus/es/hooks/use-empty-values/index.mjs')){
                const [resourcePath] = id.split(`?`, 2);
                const code = readFileSync(resourcePath).toString();
                return code.replace(`import '../../components/config-provider/index.mjs';`, '')
            }
            if( !filter(id) )return;
            const {resourcePath, query} = parseResource(id);
            return getCode.call(this, resourcePath, id, query, opt, true);
        },

        transform(code, id, opts={}){
            if( !filter(id) ) return;
            const {resourcePath,query} = parseResource(id);
            if(!code){
                return getCode.call(this, resourcePath, id, query, opts);
            }
        }
    }

    return Plugin;
}

export default EsPlugin;