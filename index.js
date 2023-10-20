import { readFileSync } from "fs";

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

function makePlugins(rawPlugins, options, cache){
    var plugins = null;
    var servers = null;
    var clients = null;
    var fsWatcher = null;
    var excludes = null;
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
                return;
            }
            if(!changed && compilation.parent){
                if( servers.has(compilation.parent) ){
                    return;
                }
            }
            if( changed ){
                const code = readFileSync(compilation.file).toString();
                clients.delete(compilation);
                if( !compilation.isValid(code) ){
                    compilation.clear();
                    compilation.parser(code);
                }else{
                    return;
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
        }

        if( options.watch ){
            fsWatcher = compiler.createWatcher();
            if( fsWatcher ){
                fsWatcher.on('change',(file)=>{
                    build(compiler.createCompilation(file), true);
                });
            }
        }
        compiler.on('onCreatedCompilation', build);
    }
    return {plugins, servers, fsWatcher, excludes, clients}
}

var hasCrossPlugin = false;
function EsPlugin(options={}){
    const filter = createFilter(options.include, options.exclude);
    const builder = compiler.applyPlugin(options.builder);
    const cache = new Map();
    const {plugins,servers, excludes, clients} = makePlugins(options.plugins, options, cache);
    const rawOpts = builder.options || {};
    const inheritPlugin = vuePlugin(Object.assign({include:/\.es$/}, rawOpts.vueOptions||{}));
    const isVueTemplate = rawOpts.format ==='vue-raw' || rawOpts.format ==='vue-template' || rawOpts.format ==='vue-jsx';
    if( plugins ){
        hasCrossPlugin = true;
    }
    const getCode = (resourcePath, query={})=>{
        const compilation = compiler.createCompilation(resourcePath);
        if( compilation ){
            const resourceFile = isVueTemplate && query.vue ? resourcePath : normalizePath(compilation, query);
            let content = builder.getGeneratedCodeByFile(resourceFile);
            if(content && compilation.isValid()){
                return {
                    code: content,
                    map: null
                };
            }else{
                return new Promise( (resolve,reject)=>{
                    const code = readFileSync(resourcePath, "utf-8");
                    if( !compilation.isValid(code) ){
                        compilation.clear();
                        compilation.parser(code);
                        cache.set(compilation, code)
                    }
                    compilation.build(builder, async (error,compilation)=>{
                        const errors = errorHandle(this, compilation);
                        if( error ){
                            errors.push( error.toString() );
                        }
                        if( errors && errors.length > 0 ){
                            reject( new Error( errors.join("\r\n") ) );
                        }else{
                            const resourceFile = isVueTemplate && query.vue ? resourcePath : normalizePath(compilation, query);
                            let content = builder.getGeneratedCodeByFile(resourceFile);
                            if( content ){
                                if( isVueTemplate && (query.vue && query.type || /^<(template|script|style)>/.test(content))){ 
                                    if(!query.src && query.vue && query.type){
                                        await inheritPlugin.transform.call(this, content, resourcePath, opts);
                                        resolve(inheritPlugin.load.call(this, resource, opts));
                                    }else{
                                        resolve(inheritPlugin.transform.call(this, content, resource, opts));  
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
        async resolveId(id){
            if( filter(id) && !path.isAbsolute(id) ){
                const className = compiler.getFileClassName(id).replace(/\//g,'.');
                const desc = Namespace.globals.get(className);
                if( desc && desc.compilation ){
                    return desc.compilation.file;
                }
            }
            if(isVueTemplate){
                return await inheritPlugin.resolveId.call(this, id);
            }
            return null;
        },

        load( id, opt ){
            if(!isVueTemplate){
                if( filter(id) ){
                    const {resourcePath, query} = parseResource(id);
                    if(query.type==='style'){
                        return getCode(resourcePath, query)
                    }
                }
                return null;
            }
            const {resourcePath, query} = parseResource(id);
            if (query.vue && query.src) {
                return getCode(resourcePath, query);
            }
            return inheritPlugin.load.call(this, id, opt);
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
            if ( !filter(id) ) return;
            const {resourcePath,resource,query} = parseResource(id);
            if(!isVueTemplate && query.type==='style'){
                return;
            }
            return new Promise( (resolve,reject)=>{
                const compilation = compiler.createCompilation(resourcePath);
                if( compilation ){
                    if( servers && servers.has(compilation) ){
                        return resolve({
                            code:clients.get(compilation) || '',
                            map:null
                        });
                    }

                    if(hasCrossPlugin && !(excludes && excludes.has(compilation)) && !compiler.isPluginInContext(builder , compilation) ){
                        return resolve({
                            code:`export default null;/*Removed "${compilation.file}" file that is not in plugin scope the "${builder.name}". */`,
                            map:null
                        });
                    }

                    if(excludes){
                        excludes.add(compilation);
                    }

                    if( isVueTemplate ){
                        if( !compilation.isValid() ){
                            compilation.clear();
                        }else if(query.type && query.vue){
                            return resolve(inheritPlugin.transform.call(this, code, id, opts));
                        }
                    }else if( !compilation.isValid(code) ){
                        compilation.clear();
                        compilation.parser(code);
                        cache.set(compilation, code)
                    }
                    compilation.build(builder, async (error,compilation,plugin)=>{
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
                            let content = plugin.getGeneratedCodeByFile(resourceFile);
                            if( content ){
                                if( isVueTemplate && (query.vue && query.type || /^<(template|script|style)>/.test(content))){
                                    if(!query.src && query.vue && query.type){
                                        await inheritPlugin.transform.call(this, content, resourcePath, opts);
                                        resolve(inheritPlugin.load.call(this, resource, opts))
                                    }else{
                                        resolve(inheritPlugin.transform.call(this, content, resource, opts));  
                                    }
                                }else{
                                    resolve({code:content, map:plugin.getGeneratedSourceMapByFile(resourceFile)||null});
                                }
                            }else{
                                reject( new Error(`'${resourceFile}' is not exists.` ) );
                            }
                        }
                    });
                }else{
                    reject( new Error(`'${resource}' is not exists.` ) );
                }
            });
        }
    }
}

export default EsPlugin;