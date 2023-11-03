const {readFileSync}  = require('fs');
const Compiler = require("easescript/lib/core/Compiler");
const rollupPluginUtils = require('rollup-pluginutils');
const path = require('path');
const vuePlugin=require("@vitejs/plugin-vue");
const compiler = new Compiler();
compiler.initialize();
process.on('exit', (code) => {
    compiler.dispose();
});

function errorHandle(context, compilation){
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
                    compilation.parser(code);
                }else{
                    return true;
                }
            }
            plugins.forEach( plugin=>{
                if( compiler.isPluginInContext(plugin , compilation) ){
                    const flag = changed || servers.has(compilation);
                    compilation.build(plugin,(error)=>{
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
                    },!flag);
                }
            });
            return true
        }
        compiler.on('onCreatedCompilation', build);
        onChanged = (compilation)=>build(compilation, true);
    }
    
    return {plugins, servers, excludes, clients, onChanged}
}

const EXPORT_HELPER_ID = "\0plugin-vue:export-helper";
var hasCrossPlugin = false;

function EsPlugin(options={}){
    const filter = createFilter(options.include, options.exclude);
    const builder = compiler.applyPlugin(options.builder);
    const cache = new Map();
    const fsWatcher = options.watch ? compiler.createWatcher() : null;
    const {plugins,servers, excludes, clients, onChanged} = makePlugins(options.plugins, options, cache, fsWatcher);
    const rawOpts = builder.options || {};
    const inheritPlugin = vuePlugin(Object.assign({include:/\.es$/}, rawOpts.vueOptions||{}));
    const isVueTemplate = rawOpts.format ==='vue-raw' || rawOpts.format ==='vue-template' || rawOpts.format ==='vue-jsx';
    if( fsWatcher && onChanged){
        fsWatcher.on('change',(file)=>{
            const compilation = compiler.createCompilation(file)
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

    function getCode(resourcePath, query={}, opts={}){
        const compilation = compiler.createCompilation(resourcePath);
        if( compilation ){

            if( servers && servers.has(compilation) ){
                return {
                    code:clients.get(compilation) || '',
                    map:null
                };
            }

            if(hasCrossPlugin && !(excludes && excludes.has(compilation)) && !compiler.isPluginInContext(builder , compilation) ){
                return {
                    code:`export default null;/*Removed "${compilation.file}" file that is not in plugin scope the "${builder.name}". */`,
                    map:null
                };
            }

            if(excludes){
                excludes.add(compilation);
            }
        
            return new Promise( (resolve,reject)=>{

                const source = readFileSync(resourcePath, "utf-8").toString();
                if( !compilation.isValid(source) ){
                    compilation.clear();
                    if( !compilation.isDescriptionType ){
                        compilation.parser(source);
                    }
                }

                compilation.build(builder, async (error,compilation)=>{
                   
                    const errors = errorHandle(this, compilation);
                    if( error ){
                        errors.push( error.toString() );
                    }
                    if( errors && errors.length > 0 ){
                        reject( new Error( errors.join("\r\n") ) );
                    }else{

                        if( query.macro && typeof builder.getMacros ==='function'){
                            const code = builder.getMacros(compilation) || '//Not found defined macro.'
                            return resolve({code:code, map:null});
                        }

                        const resourceFile = isVueTemplate && query.vue ? resourcePath : normalizePath(compilation, query);
                        let content = builder.getGeneratedCodeByFile(resourceFile);
                        if( content ){
                            if( isVueTemplate && (query.vue && query.type || /^<(template|script|style)>/.test(content))){
                                if( !query.src && query.vue && query.type ){
                                    await inheritPlugin.transform.call(this, content, parseVueFile(resourcePath), opts);
                                    const queryItems = Object.keys(query).map( key=>`${key}=${query[key]}`);
                                    const id = queryItems.length>0 ? resourcePath+'?'+queryItems.join('&') : resourcePath;
                                    resolve( inheritPlugin.load.call(this,parseVueFile(id), opts) );  
                                }else{
                                    resolve( inheritPlugin.transform.call(this, content, parseVueFile(resourcePath), opts) );  
                                }
                            }else{
                                resolve({code:content, map:builder.getGeneratedSourceMapByFile(resourceFile)||null});
                            }
                        }else{
                            reject( new Error(`'${resourceFile}' is not exists.` ) );
                        }
                    }
                })
            })
            
        }
        return null;
    }

    var __EsPlugin = null;
    return __EsPlugin = {
        name: 'vite:easescript',
        async handleHotUpdate(ctx) {
            let {file, modules, read} = ctx;
            let result = [];
            const compilation = compiler.createCompilation(file);
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
            if(!builder.options.ssr){
                builder.options.ssr = config.build?.ssr;
            }
            return config;
        },
        configResolved(config){
            const items = [builder];
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
                return inheritPlugin.load.call(this,id, opt)
            }
            if( !filter(id) )return;
            const {resourcePath, query} = parseResource(id);
            return getCode.call(this, resourcePath, query, opt);
        },

        getDoucmentRoutes(file){
            if( !filter(file) || builder.name !=='es-nuxt' ) return null;
            return new Promise( (resolve,reject)=>{
                const compilation = compiler.createCompilation(file);
                if( compilation ){
                    compilation.build(builder, (error,compilation)=>{
                        const errors = errorHandle(this, compilation);
                        if( error ){
                            errors.push( error.toString() );
                        }
                        if( errors && errors.length > 0 ){
                            reject( new Error( errors.join("\r\n") ) );
                        }else{
                            const nuxt = builder.getBuilder(compilation);
                            let module = compilation.mainModule;
                            let routes = [];
                            let items = [];
                            if(!module && compilation.modules.size > 0){
                                items = Array.from(compilation.modules.values()).filter( m=>m.isClass && !m.isDescriptionType )
                            }else{
                                items.push(module);
                            }
                            items.forEach( module=>{
                                const res = nuxt.getModuleRoutes(module);
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
                return getCode.call(this, resourcePath, query, opts);
            }
        }
    }
}

export default EsPlugin;