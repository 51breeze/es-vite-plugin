const {readFileSync, existsSync, statSync}  = require('fs');
const Compiler = require("easescript/lib/core/Compiler");
const Diagnostic = require("easescript/lib/core/Diagnostic");
const Utils = require('easescript/lib/core/Utils');
const rollupPluginUtils = require('rollup-pluginutils');
const path = require('path');
const {compileStyle}=require("vue/compiler-sfc");
const compiler = Compiler.compiler();
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
    let plugin = load();
    if(typeof plugin ==='object' && plugin.default){
        plugin = plugin.default;
    }
    return plugin(config.options)
}

function errorHandle(context, compilation){
    if( !Array.isArray(compilation.errors) )return;
    return compilation.errors.filter( error=>{
        if(error.kind === Diagnostic.ERROR){
            context.warn( error.toString() )
            return true;
        }else if(error.kind === Diagnostic.WARN){
            context.warn( error.toString() )
            return false;
        }
    }).map( item=>item.toString() );
}

function parseResource(id) {
    id = decodeURIComponent(String(id));
    if(id.startsWith('virtual:nuxt:')){
        id = id.substring(13)  
    }
    let [resourcePath, rawQuery] = id.split(`?`, 2);
    const query = Object.fromEntries(new URLSearchParams(rawQuery));
    if (query.vue != null) {
        query.vue = true;
    }
    if(resourcePath.endsWith('.es.vue')){
        resourcePath = resourcePath.slice(0, -4);
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

function createFilter(include = [/\.(es|ease)(\.vue)?(\?|$)/i], exclude = []) {
    const filter = rollupPluginUtils.createFilter(include, exclude);
    return id => filter(id);
}

function addHotServerDeps(compilation, context, serverSideRecords){
    const deps = compilation.getCompilationsOfDependency();
    deps.forEach( dep=>{
        if(dep.file && serverSideRecords.has(dep) ){
            context.addWatchFile( path.normalize(dep.file) );
        }
    });
};

function makePlugins(rawPlugins, fsWatcher, getContext){
    var plugins = null;
    var watchedRecords = null;
    if( Array.isArray(rawPlugins) && rawPlugins.length > 0 ){
        plugins = rawPlugins.map( plugin=>getBuildPlugin(plugin) );
        watchedRecords = new WeakSet();

        const addWatch = (compilation)=>{
            if(fsWatcher && !watchedRecords.has(compilation)){
                watchedRecords.add(compilation)
                fsWatcher.add(compilation.file)
            }
        }
        const build = async (plugin, compilation, changed)=>{
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
                return;
            }
            try{
                addWatch(compilation)
                if(changed){
                    await plugin.build(compilation);
                }else{
                    await plugin.run(compilation)
                }
            }catch(e){
                console.error(e)
            }
        }

        if(fsWatcher){
            fsWatcher.on('change',async (file)=>{
                const compilation = compiler.getCompilationByFile(file);
                if(compilation && !compilation.isDescriptionType){
                    plugins.forEach(plugin=>{
                        if(compiler.isPluginInContext(plugin, compilation)){
                            build(plugin, compilation, true)
                        }
                    })
                }
            })
        }

        compiler.on('onParseDone', (compilation)=>{
            if(!compilation.isDescriptionType){
                plugins.forEach(plugin=>{
                    if(compiler.isPluginInContext(plugin, compilation)){
                        build(plugin, compilation)
                    }
                })
            }
        });
    }
    
    return [plugins, watchedRecords]
}

function plugin(options={}){
    var pluginContext = null;
    var addContextDependency = null;
    const getContext = ()=>pluginContext;
    const filter = createFilter(options.include, options.exclude);
    const mainPlugin = getBuildPlugin(options.builder)
    const rawOpts = mainPlugin.options || {};
    const hotReload = !!rawOpts.hot;
    const cache = new Map();
    const fsWatcher = options.watch ? compiler.createWatcher() : null;
    const [plugins, serverSideRecords] = makePlugins(options.plugins, fsWatcher, getContext);
    const isProduction = rawOpts.mode === 'production' || process.env.NODE_ENV === 'production';
    const hotRecords = hotReload ? new Map() : null;
    if(plugins){
        hasCrossPlugin = true;
    }

    async function getCode(resourcePath, resource=null, query={}){
        if(!resource)resource = resourcePath;
        pluginContext = this;
        const compilation = await compiler.ready(resourcePath)
        if(compilation){
            cache.set(compilation, compilation.source);

            if(hasCrossPlugin && !compiler.isPluginInContext(mainPlugin , compilation) ){
                return {
                    code:`export default null;/*Removed "${compilation.file}" file that is not in plugin scope the "${mainPlugin.name}". */`,
                    map:null
                };
            }

            if(query.macro){
                query.callhook = true;
                query.action = "macros";
            }

            if(query.callhook != null && query.action){
                try{
                    let code =  await mainPlugin.callHook(compilation, query);
                    return {code}
                }catch(e){
                    return getContext().error(e);
                }
            }

            errorHandle(getContext(), compilation)

            let buildGraph = null;
            try{
                if(!query.type){
                    buildGraph = mainPlugin.getBuildGraph(compilation);
                    if(buildGraph){
                        const dependFiles = buildGraph.getDependFiles();
                        if(dependFiles && dependFiles.length>0){
                            mainPlugin.clear(compilation);
                        }
                    }
                }
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

            const dependFiles = buildGraph.getDependFiles();
            if(dependFiles && dependFiles.length>0){
                dependFiles.forEach(dependFile=>{
                    if(addContextDependency){
                        addContextDependency(dependFile.dir, compilation.file)
                    }
                    if(!dependFile.disabled){
                        dependFile.files.forEach(file=>{
                            if(existsSync(file) && statSync(file).isFile()){
                                this.addWatchFile( path.normalize(file) );
                            }
                        })
                    }
                });
            }

            let content = buildGraph.code;
            let sourcemap =  buildGraph.sourcemap;

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
                    const scopePrefix = mainPlugin.options?.vue?.scopePrefix || "";
                    const scopeId = query.scoped ? (scopePrefix + query.scoped) : '';
                    const result = compileStyle({
                        source:content,
                        filename:resourcePath,
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
            }else if(serverSideRecords){
                addHotServerDeps(compilation, getContext(), serverSideRecords)
            }

            if(!content){
                getContext().error(`Build error code is empty. on the "${resource}"`);
                return;
            }

            return {
                code:content,
                map:sourcemap
            }
            
        }else{
           throw new Error(`'${resource}' is not exists.`)
        }
    }

    const api = {
        name: 'vite:easescript',
        async handleHotUpdate(ctx) {
            let {file, modules, read, server} = ctx;
            if(!filter(file) || !hotRecords)return;
            const compilation = await compiler.createCompilation(file);
            if(compilation){
                if(rawOpts.importFormation.ext?.enabled && rawOpts.importFormation.ext.suffix){
                    ctx.file = compiler.resolveExtFormat(file, rawOpts.importFormation.ext.suffix)
                }
                const code = await read();
                if(cache.get(compilation) !== code){
                    cache.set(compilation, code);
                    if(!(serverSideRecords && serverSideRecords.has(compilation))){
                        if(!modules.length){
                            modules = [
                                ...Array.from(server.moduleGraph.fileToModulesMap.get(ctx.file) || []),
                            ];
                        }
                        await compilation.ready();
                    }else{
                        modules.length = 0;
                        //服务端文件变更，找出依赖服务端的前端模块
                        compilation.referenceCompilations.forEach( (dep)=>{
                            if(!dep.isDescriptorDocument() && dep !== compilation){
                                if(!serverSideRecords.has(dep) && compiler.isPluginInContext(mainPlugin, dep)){
                                    const result = server.moduleGraph.fileToModulesMap.get(dep.file)
                                    if(result){
                                        result.forEach(mod=>{
                                            if(mod.id===dep.file){
                                                modules.push(mod)
                                            }
                                        })
                                    }
                                }
                            }
                        })
                        return modules;
                    }

                    if(compilation.stack){
                        const changed = new Set();
                        const oldSection = hotRecords.get(compilation);
                        const newSection = getSections(compilation);
                        hotRecords.set(compilation, newSection);
                        modules.forEach( mod=>{
                            if(directRequestRE.test(mod.url))return;
                            if(mod.url.includes("macro=true")){
                                if(!oldSection || oldSection.script !== newSection.script){
                                    changed.add(mod);
                                }
                            }else if(styleRequestRE.test(mod.url)){
                                if(!oldSection || oldSection.style !== newSection.style){
                                    changed.add(mod);
                                }
                            }else if(!oldSection || (oldSection.script !== newSection.script || oldSection.jsx !== newSection.jsx)){
                                changed.add(mod);
                            }
                        });
                        return Array.from(changed.values());
                    }else{
                        errorHandle(getContext(), compilation)
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
        configureServer(server){
            if(hotReload){
                const fsWatcher = compiler.createWatcher();
                const context = {};
                const invalidate = (_path)=>{
                    const key = path.normalize(_path)
                    const matched = Object.keys(context).find(k=>{
                        return key.startsWith(k)
                    })
                    const files = context[matched];
                    if(Array.isArray(files)){
                        const modules = files.map(file=>{
                            const result = server.moduleGraph.fileToModulesMap.get(file);
                            if(result){
                                return Array.from(result.values());
                            }
                            return []
                        }).flat()
                        server.ws.send('vite:fileAdd', {path:Utils.normalizePath(_path)});
                        modules.forEach(mod=>{
                            server.moduleGraph.invalidateModule(mod);
                        })
                    }
                }
                fsWatcher.on('unlink', invalidate)
                fsWatcher.on('add', invalidate)
                addContextDependency = (contextDir, file)=>{
                    const key = path.normalize(contextDir)
                    const items = context[key] || (context[key]=[])
                    items.push(file)
                    fsWatcher.add(contextDir)
                }
            }
        },
        buildStart(){
            pluginContext = this;
        },
        async resolveId(id){
            if(!filter(id))return;
            let query = null;
            if(id.includes('?')){
                let [_source, _query, ..._other] = id.split('?');
                if(_other.length>0){
                    _query = [..._other, _query].filter(Boolean).join('&')
                } 
                id = _source;
                query = _query;
            }
            let file = id;
            let otherExtname = null;
            let ext = rawOpts.importFormation?.ext;
            if(ext?.enabled && ext.suffix){
                let extname = path.extname(file);
                if(!compiler.isExtensionName(extname)){
                    otherExtname = extname;
                    file = file.slice(0,-extname.length)
                }
            }
            let isAbs = path.isAbsolute(file);
            if(!isAbs || !existsSync(file)){
                if(isAbs && file.startsWith('/')){
                    file = file.slice(1)
                }
                file = compiler.resolveManager.resolveFile(file) || file;
            }
            if(otherExtname){
                file += otherExtname;
            }
            if(query){
                file += '?'+query;
            }
            return file;
        },
        async getRoutes(file){
            if( !filter(file) || mainPlugin.name !=='es-nuxt' ) return null;
            const compilation = await compiler.ready(file);
            if(compilation){
                return await mainPlugin.resolveRoutes(compilation);
            }else{
                throw new Error( `getRoutes "${file}" is not exists.` );
            }
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

    return api;
}

module.exports = plugin