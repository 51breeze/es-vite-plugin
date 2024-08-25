const {readFileSync}  = require('fs');
const Compiler = require("easescript/lib/core/Compiler");
const Diagnostic = require("easescript/lib/core/Diagnostic");
const rollupPluginUtils = require('rollup-pluginutils');
const path = require('path');
const vuePlugin=require("@vitejs/plugin-vue");
const {compileStyle}=require("vue/compiler-sfc");
const compiler = new Compiler();
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

process.on('exit', () => {
    compiler.dispose();
});

function getBuilderPlugin(config={}){
    const load = ()=>{
        if(config.plugin && typeof config.plugin==='function'){
            return config.plugin;
        }else if(config.name){
            return require(config.name)
        }else{
            throw new Error('Plugin name invalid')
        }
    }
    const builder = load();
    return new builder(compiler, config.options)
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

function makePlugins(rawPlugins, options, cache, fsWatcher){
    var plugins = null;
    var servers = null;
    var clients = null;
    var excludes = null;
    if( Array.isArray(rawPlugins) && rawPlugins.length > 0 ){
        servers = new WeakSet();
        excludes = new WeakSet();
        clients = new Map()
        plugins = rawPlugins.map( plugin=>getBuilderPlugin(plugin) );

        const build = (compilation, changed)=>{

            if(!compilation || compilation.isDescriptionType){
                return false;
            }

            if( changed ){
                const code = readFileSync(compilation.file,"utf-8").toString();
                if( !compilation.isValid(code) ){
                    compilation.clear();
                    compilation.createStack(code);
                }else{
                    return true;
                }
            }

            plugins.forEach( plugin=>{
                if( compiler.isPluginInContext(plugin , compilation) ){
                    const done = (error)=>{
                        if(error){
                            console.error( error instanceof Error ? error : error.toString() );
                        }else{
                            if(!changed){
                                cache.set(compilation, compilation.source);
                            }
                        }
                    }
                    compilation.ready().then(()=>{
                        if(changed){
                            plugin.build(compilation, done)
                        }else{
                            plugin.start(compilation, done)
                        }
                    })
                }
            });
            return true
        }
        compiler.on('onParseDone', build);
        if(fsWatcher){
            fsWatcher.on('change',async (file)=>{
                const compilation = await compiler.createCompilation(file);
                build(compilation, true);
            });
        }
    }
    
    return {plugins, servers, excludes, clients}
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

    const filter = createFilter(options.include, options.exclude);
    const mainPlugin = getBuilderPlugin(options.builder)
    const cache = new Map();
    const fsWatcher = options.watch ? compiler.createWatcher() : null;
    const {plugins,servers, excludes, clients} = makePlugins(options.plugins, options, cache, fsWatcher);
    const rawOpts = mainPlugin.options || {};
    const inheritPlugin = vuePlugin(Object.assign({include:/\.es$/}, rawOpts.vueOptions||{}));
    const isVueTemplate = rawOpts.format ==='vue-raw' || rawOpts.format ==='vue-template' || rawOpts.format ==='vue-jsx';
    const isProduction = rawOpts.mode === 'production' || process.env.NODE_ENV === 'production';
    const parseVueFile=(id, realFlag=false)=>{
        if(!isVueTemplate)return id;
        if( id.startsWith('es-vue-virtual:')){
            id = id.substring(15);
        }
        return realFlag ? id : 'es-vue-virtual:'+id;
    }
    const hotReload = !!rawOpts.hot;
    const hotRecords = hotReload ? new Map() : null;
    if(rawOpts.hot && isVueTemplate){
        rawOpts.hot = false;
    }
    if( plugins ){
        hasCrossPlugin = true;
    } 

    async function getCode(resourcePath, resource=null, query={}, opts={}, isLoad=false){
        if(!resource)resource = resourcePath;
        const compilation = await compiler.ready(resourcePath)
        if( compilation ){
            cache.set(compilation, compilation.source);
            
            if(hasCrossPlugin && !compiler.isPluginInContext(mainPlugin , compilation) ){
                return {
                    code:`export default null;/*Removed "${compilation.file}" file that is not in plugin scope the "${mainPlugin.name}". */`,
                    map:null
                };
            }

            return await new Promise( async(resolve,reject)=>{
                mainPlugin.build(compilation, async(error)=>{
                    const errors = errorHandle(this, compilation);
                    if( error ){
                        errors.push( error.toString() );
                    }
                    if( errors && errors.length > 0 ){
                        reject( new Error( errors.join("\r\n") ) );
                    }else{
                        
                        if( query.macro && typeof mainPlugin.getMacros ==='function'){
                            const code = await mainPlugin.getMacros(compilation) || '//Not found defined macro.'
                            return resolve({code:code, map:null});
                        }

                        let content = null;
                        let sourceMap =  null;
                        resourcePath = compilation.file || compiler.normalizePath(resourcePath);

                        if(!isVueTemplate && query.type === 'style' || query.type === 'embedAssets'){
                            let asset = mainPlugin.getBuildAssets(resourcePath, query.index, query.type);
                            if(asset){
                                content = asset.content;
                            }
                        }else{
                            let buildModule = mainPlugin.getBuildModule(resourcePath, isVueTemplate || query.type ? null : query.id )
                            if(buildModule){
                                content = buildModule.content
                                sourceMap = buildModule.sourceMap
                            }
                        }

                        if( content ){
                            
                            if(query.type === 'embedAssets'){
                                return resolve({
                                    code:`export default ${JSON.stringify(content)}`
                                });
                            }

                            if(query.src){
                                return resolve({
                                    code:content,
                                    map:sourceMap
                                })
                            }

                            if( isVueTemplate && (query.vue && query.type || /^<(template|script|style)>/.test(content))){
                                if(query.vue && query.type){
                                    resolve( inheritPlugin.load.call(this,parseVueFile(resource), opts) ); 
                                }else{
                                    Promise.resolve(inheritPlugin.transform.call(this, content, parseVueFile(resourcePath), opts)).then( result=>{
                                        const records = hotRecords.get(compilation);
                                        if(records){
                                            const prev = records.prev;
                                            const last = records.last;
                                            const onlyRender = prev && last && prev.script === last.script && prev.style === last.style && prev.jsx !== last.jsx;
                                            if (onlyRender && result.code) {
                                                result.code += `\nexport const _rerender_only = true;`
                                            }
                                        }
                                        resolve(result);
                                    });
                                }
                            }else{
                                if(query && query.type === 'style' && compileStyle){
                                    const lang = query.lang;
                                    const scoped = !!query.scopeId;
                                    const scopeId = scoped ? (rawOpts.scopeIdPrefix + query.scopeId) : '';
                                    const result = compileStyle({
                                        source:content,
                                        filename:resourcePath,
                                        scoped,
                                        inMap:sourceMap,
                                        id:scopeId,
                                        preprocessLang:allowPreprocessLangs.includes(lang) ? lang :  undefined,
                                        isProd:isProduction
                                    });
                                    content =result.code;
                                    sourceMap = result.map;
                                }
                                resolve({code:content, map:sourceMap});
                            }
                        }else{
                            reject( new Error(`'${resource}' is not exists.`) );
                        }
                    }
                });
            });
            
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
                        if(isVueTemplate && hasStyleChanged){
                            const result = await getCode(file, file, {src:true});
                            await inheritPlugin.transform.call(pluginContext, result.code, parseVueFile(file), {})
                        }
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
            if(isVueTemplate){
                return inheritPlugin.config.call(this, config);
            }
            if(!mainPlugin.options.ssr){
                mainPlugin.options.ssr = config.build?.ssr;
            }
            return config;
        },
        configResolved(config){
            const items = [mainPlugin];
            if( plugins ){
                items.push(...plugins)
            }
            const sourcemap = config.command === "build" ? !!config.build.sourcemap : true;
            items.forEach( plugin=>{
                if(!plugin.options.sourceMaps){
                    plugin.options.sourceMaps = sourcemap;
                }
                if( !plugin.options.metadata.env.NODE_ENV ){
                    const isProduction = process.env.NODE_ENV === "production" || config.isProduction;
                    plugin.options.metadata.env.NODE_ENV = isProduction ? 'production' : 'development';
                }
            });
            if( sourcemap ){
                compiler.options.parser.locations=true;
            }
            if(isVueTemplate){
                inheritPlugin.configResolved.call(this, config);
                const hasInspect = config.plugins.some( plugin=>plugin.name==='vite-plugin-inspect');
                if(hasInspect){
                    const wrap = (target)=>{
                        if( 'handler' in target){
                            target.handler = wrap(target.handler);
                            return target;
                        }
                        return function(...args){
                            const id = args[1];
                            if( filter(id) ){
                                return Plugin.transform.call(this, ...args);
                            }
                            return target.call(this, ...args);
                        }
                    };
                    config.plugins.forEach( plugin=>{
                        if(plugin.name ==='vite:vue'){
                            if('transform' in plugin){
                                plugin.transform = wrap(plugin.transform)
                            }
                        }
                    });
                }
            }
        },
        configureServer(server){
            if(isVueTemplate){
                inheritPlugin.configureServer.call(this, server);
            }
        },
        buildStart(){
            if(isVueTemplate){
                inheritPlugin.buildStart.call(this);
            }
        },
        async resolveId(id, ...args){
            if(isVueTemplate && id===EXPORT_HELPER_ID){
                return id;
            }
            id = parseVueFile(id, true);
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
            if(isVueTemplate){
                return await inheritPlugin.resolveId.call(this, ...[id, ...args]);
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
            if(isVueTemplate && id===EXPORT_HELPER_ID){
                return helperCode;
            }
            //fix: use-empty-values, config-provider 这两个组件存在相互依赖，在打包构建时有问题
            if(id && id.includes('element-plus/es/hooks/use-empty-values/index.mjs')){
                const [resourcePath] = id.split(`?`, 2);
                const code = readFileSync(resourcePath).toString();
                return code.replace(`import '../../components/config-provider/index.mjs';`, '')
            }
            if( !filter(id) )return;
            const {resourcePath, query} = parseResource(id);
            pluginContext = this;
            return getCode.call(this, resourcePath, id, query, opt, true);
        },

        transform(code, id, opts={}){
            if( !filter(id) ) return;
            const {resourcePath,query} = parseResource(id);
            if(isVueTemplate && query.vue && query.type && code){
                return inheritPlugin.transform.call(this, code, parseVueFile(id), opts);
            }
            if(!code){
                return getCode.call(this, resourcePath, id, query, opts);
            }
        }
    }

    return Plugin;
}

export default EsPlugin;