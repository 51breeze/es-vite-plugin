const {readFileSync}  = require('fs');
const Compiler = require("easescript/lib/core/Compiler");
const rollupPluginUtils = require('rollup-pluginutils');
const path = require('path');
const vuePlugin=require("@vitejs/plugin-vue");
const compiler = new Compiler();
process.on('exit', () => {
    compiler.dispose();
});

function errorHandle(context, compilation){
    if( !Array.isArray(compilation.errors) )return;
    return compilation.errors.filter( error=>{
        if( error.kind === 1){
            context.warn( error.toString() )
            return false;
        }else{
            return true;
        }
    }).map( item=>item.toString() );
}

function normalizePath(compilation, query={}){
    return compiler.normalizeModuleFile(compilation, query.id, query.type, query.file)
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

function createFilter(include = [/\.es(\?|$)/i], exclude = []) {
    const filter = rollupPluginUtils.createFilter(include, exclude);
    return id => filter(id);
}

function makePlugins(rawPlugins, options, cache, fsWatcher){
    var plugins = null;
    var servers = null;
    var clients = null;
    var excludes = null;
    var onChanged = null;
    if( Array.isArray(rawPlugins) && rawPlugins.length > 0 ){
        servers = new WeakSet();
        excludes = new WeakSet();
        clients = new Map()
        plugins = rawPlugins.map( plugin=>compiler.applyPlugin(plugin) );
        const watchDeps=(compilation, deps, subFlag=false)=>{
            if(!compilation || compilation.isDescriptionType)return;
            const isLocal = compilation.pluginScopes.scope==='local';
            if(!servers.has(compilation)){
                if(isLocal && fsWatcher){
                    fsWatcher.add(compilation.file);
                }
                servers.add(compilation);
            }
            if( isLocal ){
                if(deps && subFlag)deps.add(compilation);
                compilation.getCompilationsOfDependency().forEach( (dep)=>watchDeps(dep, deps, true) );
            }
        }
        const build = (compilation, changed)=>{
            if(!compilation || compilation.isDescriptionType || excludes.has(compilation)){
                return false;
            }
            if(!changed && compilation.parent){
                if( servers.has(compilation.parent) ){
                    return true;
                }
            }
            if( changed ){
                const code = readFileSync(compilation.file,"utf-8").toString();
                clients.delete(compilation);
                if( !compilation.isValid(code) ){
                    compilation.clear();
                    compilation.createStack(code);
                }else{
                    return true;
                }
            }
            plugins.forEach( plugin=>{
                if( compiler.isPluginInContext(plugin , compilation) ){
                    const flag = changed || servers.has(compilation);
                    const done = (error)=>{
                        if( !changed ){
                            cache.set(compilation, compilation.source);
                        }

                        if( !clients.has(compilation) ){
                            const deps = new Set();
                            watchDeps(compilation, deps)
                            const items = [...deps].map( dep=>{
                                return `import "${dep.file}";\r\n`
                            });
                            clients.set(compilation, `${items.join('')}export default null;/*Removed service side code ${Math.random()}*/`)
                        }

                        if( error ){
                            console.error( error instanceof Error ? error : error.toString() );
                        }
                    }
                    compilation.ready().then(()=>{
                        if(flag){
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
        onChanged = (compilation)=>build(compilation, true);
    }
    
    return {plugins, servers, excludes, clients, onChanged}
}

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

var hasCrossPlugin = false;

function EsPlugin(options={}){
    const filter = createFilter(options.include, options.exclude);
    const mainPlugin = compiler.applyPlugin(options.builder);
    const cache = new Map();
    const fsWatcher = options.watch ? compiler.createWatcher() : null;
    const {plugins,servers, excludes, clients, onChanged} = makePlugins(options.plugins, options, cache, fsWatcher);
    const rawOpts = mainPlugin.options || {};
    const inheritPlugin = vuePlugin(Object.assign({include:/\.es$/}, rawOpts.vueOptions||{}));
    const isVueTemplate = rawOpts.format ==='vue-raw' || rawOpts.format ==='vue-template' || rawOpts.format ==='vue-jsx';
    if( fsWatcher && onChanged){
        fsWatcher.on('change',async (file)=>{
            const compilation = await compiler.createCompilation(file)
            onChanged(compilation);
        });
    }

    if( plugins ){
        hasCrossPlugin = true;
    }

    const parseVueFile=(id, realFlag=false)=>{
        if(!isVueTemplate)return id;
        if( id.startsWith('es-vue-virtual:')){
            id = id.substring(15);
        }
        return realFlag ? id : 'es-vue-virtual:'+id;
    }

    async function getCode(resourcePath, resource, query={}, opts={}){
        
        const compilation = await compiler.ready(resourcePath)
        if( compilation ){

            if( servers && servers.has(compilation) ){
                return {
                    code:clients.get(compilation) || '',
                    map:null
                };
            }

            if(hasCrossPlugin && !(excludes && excludes.has(compilation)) && !compiler.isPluginInContext(mainPlugin , compilation) ){
                return {
                    code:`export default null;/*Removed "${compilation.file}" file that is not in plugin scope the "${mainPlugin.name}". */`,
                    map:null
                };
            }

            if(excludes){
                excludes.add(compilation);
            }
        
            return await new Promise( (resolve,reject)=>{

                mainPlugin.build(compilation, (error)=>{
                   
                    const errors = errorHandle(this, compilation);
                    if( error ){
                        console.log( error )
                        errors.push( error.toString() );
                    }
                    if( errors && errors.length > 0 ){
                        reject( new Error( errors.join("\r\n") ) );
                    }else{

                        if( query.macro && typeof mainPlugin.getMacros ==='function'){
                            const code = mainPlugin.getMacros(compilation) || '//Not found defined macro.'
                            return resolve({code:code, map:null});
                        }

                        const resourceFile = isVueTemplate && query.vue ? resourcePath : normalizePath(compilation, query);
                        let content = mainPlugin.getGeneratedCodeByFile(resourceFile);
                        if( content ){
                            if( isVueTemplate && (query.vue && query.type || /^<(template|script|style)>/.test(content))){
                                if( !query.src && query.vue && query.type ){
                                    resolve( inheritPlugin.load.call(this,parseVueFile(resource), opts) );  
                                }else{
                                    resolve( inheritPlugin.transform.call(this, content, parseVueFile(resourcePath), opts) );
                                }
                            }else{
                                resolve({code:content, map:mainPlugin.getGeneratedSourceMapByFile(resourceFile)||null});
                            }
                        }else{
                            reject( new Error(`'${resourceFile}' is not exists.`) );
                        }
                    }
                })
            })
            
        }else{
           throw new Error(`'${resourcePath}' is not exists.`)
        }
    }

    var __EsPlugin = null;
    return __EsPlugin = {
        name: 'vite:easescript',
        async handleHotUpdate(ctx) {
            if(isVueTemplate){
                return inheritPlugin.handleHotUpdate.call(this, ctx);
            }
            let {file, modules, read} = ctx;
            let result = [];
            const compilation = await compiler.createCompilation(file);
            if( compilation ){
                const code = await read();
                if( cache.get(compilation) !== code ){
                    result.push(...modules)
                    cache.set(compilation, code)
                }
            }
            return result;
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
                                return __EsPlugin.transform.call(this, ...args);
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
                server = Object.assign({}, server);
                server.config = Object.assign({}, server.config);
                server.config.server = Object.assign({}, server.config.server);
                server.config.server.hmr = false
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
                    const className = compiler.getFileClassName(id).replace(/\//g,'.');
                    const desc = Namespace.globals.get(className);
                    if( desc && desc.compilation ){
                        return desc.compilation.file;
                    }
                }
                return id;
            }
            if(isVueTemplate){
                return await inheritPlugin.resolveId.call(this, ...[id, ...args]);
            }
        },

        load( id, opt ){
            if(isVueTemplate && id===EXPORT_HELPER_ID){
                return helperCode;
            }
            if( !filter(id) )return;
            const {resourcePath, query} = parseResource(id);
            return getCode.call(this, resourcePath, id, query, opt);
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
}

export default EsPlugin;