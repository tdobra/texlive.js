//Restricted version of texlive.js containing only what is required for TCTemplate (no BibTeX)
//Class instances persist, but Emscripten worker can only be run once, so must reload each time
//Await ready promise, then await compile promise, then loop - do not await ready while compile is running

"use strict";

class TeXLive {
  constructor(obj) {
    //Private properties
    this.worker = undefined;
    if (obj.texURL === undefined) { throw new Error("texURL undefined"); }
    this.texURL = obj.texURL;
    this.workerFolder = obj.workerFolder;
    if (this.workerFolder === undefined) { this.workerFolder = ""; }
    this.onlog = obj.onlog;
    this.packages = this.getPackages();
    //Public functions
    this.createCmd("FS_createDataFile"); // parentPath, filename, data, canRead, canWrite
    this.createCmd("FS_readFile"); // filename
    //Private functions
    this.createCmd("FS_createPath"); // parent, name, canRead, canWrite
    this.createCmd("set_TOTAL_MEMORY"); // size
    //Public properties
    this.ready = this.prestart();  //Returns a promise
  }

  async compile() {
    await this.ready;
    await this.sendCmd({
      "command": "run",
      "arguments": ["-interaction=nonstopmode", "-output-format", "pdf", "input.tex"]
    });
    const binary_pdf = this.FS_readFile("/input.pdf");
    await binary_pdf;

    //Reset system
    this.terminate();
    //Ready is reset to new promise before compile promise resolves
    this.ready = this.prestart();

    //Return values
    if (binary_pdf === false) { throw new Error("PDF failed to compile"); }
    return "data:application/pdf;charset=binary;base64," + btoa(binary_pdf);
  }

  terminate() {
    if (this.worker !== undefined) {
      this.worker.terminate();
      this.worker = undefined;
    }
  }

  //Private functions
  createCmd(cmd) {
    //args is an array
    this[cmd] = (...args) => this.sendCmd({
      "command":  cmd,
      "arguments": args
    });
  }

  async getPackages() {
    //Load TeXLive file list
    const packageList = await TeXLive.getFile(this.workerFolder + "texlivelight.lst");

    //List of URLs. Remove last element as blank.
    const urlList = packageList.split("\n").pop();

    //Read and sort the list
    const folders = [];
    const files = [];
    for (const url of urlList) {
      const lastSeparator = url.lastIndexOf("/");
      //Path and name do not include the / separating them
      if (url.endsWith(".")) {
        folders.push(url.substring(0, lastSeparator - 1));
      } else {
        files.push({
          fullurl: this.workerFolder + "texlive" + url,
          path: url.substring(0, lastSeparator),
          name: url.substring(lastSeparator + 1)
        });
      }
    }

    return {
      folders: folders,
      files: files,
    };
  }

  handleMsg(ev) {
    const data = JSON.parse(ev.data);
    if (!("command" in data)) { console.warn("Message from worker missing command: ", data); }
    switch (data.command) {
    case "ready":
      this.workerReady();
      break;
    case "stdout":
    case "stderr":
      this.onlog(data.contents);
      break;
    default:
      const msg_id = data.msg_id;
      if (("msg_id" in data) && (msg_id in this.cmdResolves)) {
        this.cmdResolves[msg_id](data.result);
      } else {
        console.warn("Unknown worker message " + msg_id + "!");
      }
    }
  }

  async prestart() {
    //Initiate file downloads
    const workerSrc = TeXLive.getFile(this.workerFolder + "pdftex-worker.js");
    const texSrc = TeXLive.getFile(this.texURL);

    //Start worker
    const texliveInstance = this;
    const workerProm = new Promise((resolve) => { this.workerReady = resolve; });
    this.cmdResolves = [];
    this.worker = new Worker(await workerSrc);
    //Make sure event handler uses this to refer to TeXLive instance
    this.worker.addEventListener("message", (ev) => { this.handleMsg(ev); }, { passive: true });
    await workerProm;

    //Set memory
    const memSize = 80 * 1024 * 1024;
    const availableSize = await this.set_TOTAL_MEMORY(memSize);
    if (availableSize < memSize) { console.warn("Memory limited to " + availableSize.toString() + "B"); }

    //Add folders then files to emscripten
    const packages = await this.packages;

    //Folders are created recursively
    await Promise.all(packages.folders.map(async (folder) => this.FS_createPath("/", folder, true, true)));
    alert("CP1");
    const packageLoads = packages.files.map(async (file) => this.FS_createDataFile(file.path, file.name, TeXLive.getFile(file.fullurl), true, false));
    alert("CP2");
    packageLoads.push(this.FS_createDataFile("/", "input.tex", await texSrc, true, false));
    alert("CP3");
    await Promise.all(packageLoads);
    alert("CP4");
  }

  async sendCmd(cmd) {
    const prom = new Promise((resolve) => {
      const msg_id = this.cmdResolves.push(resolve) - 1;
      cmd.msg_id = msg_id;
    });
    await this.workerReady;
    this.worker.postMessage(JSON.stringify(cmd));
    return prom;
  };
}

//Static properties on class - to be only run once. Static properties in class are not yet fully supported.
TeXLive.getFile = (() => {
  //Download and store each required source file
  const paths = [];
  const contents = [];

  return async (path) => {
    const pathInd = paths.indexOf(path);
    if (pathInd === -1) {
      //Not found: need to download
      const fileFetch = await fetch(path);
      if (!fileFetch.ok) { throw new Error("Could not download file " + path + ": " + fileFetch.status); }
      let fileContent;
      if (path.endsWith(".js")) {
        //Web workers need a data URL
        fileContent = URL.createObjectURL(await fileFetch.blob());
      } else if (path.endsWith(".lst")) {
        fileContent = await fileFetch.text();
      } else {
        fileContent = await fileFetch.arrayBuffer();
      }
      contents.push(fileContent);
      paths.push(path);
      return fileContent;
    } else {
      return contents[pathInd];
    }
  };
})();



// TeXLive.chunksize = (async () => {
  //   //TODO: Does this need to be async? Is this even needed?
  //   //Determine the maximum size in bytes of data that can be messaged to worker
  //   //Uses bisection terminating when size is known to within 200B
  //   let size = 1024;
  //   let max = undefined;  //Minimum known failure size
  //   let min = undefined;  //Maximum known ok size
  //   let delta = size;
  //   let success = true;
  //   let buf;
  //
  //   //delta is integer > 50, so can always be represented exactly at double precision - no rounding function required
  //   while (Math.abs(delta) > 100) {
    //     if (success) {
      //       min = size;
      //       if (max === undefined) {
        //         delta = size;
        //       } else {
          //         delta = 0.5 * (max - size);
          //       }
          //     } else {
            //       max = size;
            //       if (min === undefined) {
              //         delta = -0.5 * size;
              //       } else {
                //         delta = -0.5 * (size - min);
                //       }
                //     }
                //     size += delta;
                //
                //     success = true;
                //     try {
                  //       buf = String.fromCharCode.apply(null, new Uint8Array(size));
                  //       sendCommand({
                    //         command: "test",
                    //         data: buf
                    //       });
                    //     } catch {
                      //       success = false;
                      //     }
                      //   }
                      //
                      //   return size;
                      // })();

                      // var TeXLive = function(opt_workerPath) {
                      //   //var self=this;
                      //   var chunksize= determineChunkSize();
                      //   if (!opt_workerPath) {
                      //     opt_workerPath = '';
                      //   }
                      //
                      //
                      //   var component = function(workerPath) {
                      //     var self = this;
                      //     var worker = new Worker(workerPath);
                      //     self.terminate = function(){worker.terminate()};
                      //     self.initialized=false;
                      //     self.on_stdout = function(msg) {
                      //       console.log(msg);
                      //     }
                      //
                      //     self.on_stderr = function(msg) {
                      //       console.log(msg);
                      //     }
                      //     worker.onmessage = function(ev) {
                      //       var data = JSON.parse(ev.data);
                      //       var msg_id;
                      //       if(!('command' in data))
                      //         console.log("missing command!", data);
                      //       switch(data['command']) {
                      //       case 'ready':
                      //         onready.done(true);
                      //         break;
                      //       case 'stdout':
                      //       case 'stderr':
                      //         self['on_'+data['command']](data['contents']);
                      //         break;
                      //       default:
                      //         //console.debug('< received', data);
                      //         msg_id = data['msg_id'];
                      //         if(('msg_id' in data) && (msg_id in promises)) {
                      //           promises[msg_id].done(data['result']);
                      //         }
                      //         else
                      //           console.warn('Unknown worker message '+msg_id+'!');
                      //       }
                      //     }
                      //     var onready = new promise.Promise();
                      //     var promises = [];
                      //     var chunkSize = undefined;
                      //     self.sendCommand = function(cmd) {
                      //       var p = new promise.Promise();
                      //       var msg_id = promises.push(p)-1;
                      //       onready.then(function() {
                      //         cmd['msg_id'] = msg_id;
                      //         worker.postMessage(JSON.stringify(cmd));
                      //       });
                      //       return p;
                      //     };
                      //     self.createCommand = function(command) {
                      //       self[command] = function() {
                      //         var args = [].concat.apply([], arguments);
                      //
                      //         return self.sendCommand({
                      //           'command':  command,
                      //           'arguments': args,
                      //         });
                      //       }
                      //     }
                      //     self.createCommand('FS_createDataFile'); // parentPath, filename, data, canRead, canWrite
                      //     self.createCommand('FS_readFile'); // filename
                      //     self.createCommand('FS_unlink'); // filename
                      //     self.createCommand('FS_createFolder'); // parent, name, canRead, canWrite
                      //     self.createCommand('FS_createPath'); // parent, name, canRead, canWrite
                      //     self.createCommand('FS_createLazyFile'); // parent, name, canRead, canWrite
                      //     self.createCommand('FS_createLazyFilesFromList'); // parent, list, parent_url, canRead, canWrite
                      //     self.createCommand('set_TOTAL_MEMORY'); // size
                      //   };
                      //
                      //   var pdftex=new component(opt_workerPath+'pdftex-worker.js');
                      //   pdftex.compile = function(source_code) {
                      //     var self=this;
                      //     var p = new promise.Promise();
                      //     pdftex.compileRaw(source_code).then(
                      //       function(binary_pdf) {
                      //         if(binary_pdf === false)
                      //           return p.done(false);
                      //         pdf_dataurl = 'data:application/pdf;charset=binary;base64,' + window.btoa(binary_pdf);
                      //         return p.done(pdf_dataurl);
                      //       });
                      //       return p;
                      //     };
                      //     pdftex.compileRaw = function(source_code) {
                      //       var self=this;
                      //       return pdftex.run(source_code).then(
                      //         function() {
                      //           return self.FS_readFile('/input.pdf');
                      //         }
                      //       );
                      //     };
                      //     pdftex.run = function(source_code) {
                      //       var self=this;
                      //       var commands;
                      //       if(self.initialized)
                      //       commands = [
                      //         curry(self, 'FS_unlink', ['/input.tex']),
                      //         curry(self, 'FS_createDataFile', ['/', 'input.tex', source_code, true, true])
                      //       ];
                      //       else
                      //       commands = [
                      //         curry(self, 'FS_createDataFile', ['/', 'input.tex', source_code, true, true]),
                      //         curry(self, 'FS_createLazyFilesFromList', ['/', 'texlive.lst', './texlive', true, true]),
                      //       ];
                      //
                      //       var sendCompile = function() {
                      //         self.initialized = true;
                      //         return self.sendCommand({
                      //           'command': 'run',
                      //           'arguments': ['-interaction=nonstopmode', '-output-format', 'pdf', 'input.tex'],
                      //           //        'arguments': ['-debug-format', '-output-format', 'pdf', '&latex', 'input.tex'],
                      //         });
                      //       };
                      //       return promise.chain(commands)
                      //       .then(sendCompile)
                      //     };
                      //     TeXLive.prototype.pdftex = pdftex;
                      //
                      //     var bibtex = new component(opt_workerPath+'bibtex-worker.js');
                      //     bibtex.compile = function(aux){
                      //       var self=this;
                      //       var p = new promise.Promise();
                      //       bibtex.compileRaw(aux).then(
                      //         function(binary_bbl) {
                      //           if(binary_bbl === false)
                      //             return p.done(false);
                      //           pdf_dataurl = 'data:text/plain;charset=binary;base64,' + window.btoa(binary_bbl);
                      //           return p.done(pdf_dataurl);
                      //         });
                      //         return p;
                      //       };
                      //       bibtex.compileRaw = function(aux) {
                      //         var self=this;
                      //         return bibtex.run(aux).then(
                      //           function() {
                      //             return self.FS_readFile('/input.bbl');
                      //           }
                      //         );
                      //       };
                      //       bibtex.run = function(source_code) {
                      //         var self=this;
                      //         var commands;
                      //         if(self.initialized)
                      //         commands = [
                      //           curry(self, 'FS_unlink', ['/input.aux']),
                      //           curry(self, 'FS_createDataFile', ['/', 'input.aux', aux, true, true])
                      //         ];
                      //         else
                      //         commands = [
                      //           curry(self, 'FS_createDataFile', ['/', 'input.aux', aux, true, true]),
                      //           curry(self, 'FS_createLazyFilesFromList', ['/', 'texlive.lst', './texlive', true, true]),
                      //         ];
                      //         var sendCompile = function() {
                      //           self.initialized = true;
                      //           return self.sendCommand({
                      //             'command': 'run',
                      //             'arguments': ['input.aux'],
                      //           });
                      //         };
                      //         return promise.chain(commands)
                      //         .then(sendCompile)
                      //       };
                      //       TeXLive.prototype.bibtex=bibtex;
                      //       TeXLive.prototype.terminate = function(){
                      //         pdftex.terminate();
                      //         bibtex.terminate();
                      //       }
                      //     };
                      //     var determineChunkSize = function() {
                      //       var size = 1024;
                      //       var max = undefined;
                      //       var min = undefined;
                      //       var delta = size;
                      //       var success = true;
                      //       var buf;
                      //
                      //       while(Math.abs(delta) > 100) {
                      //         if(success) {
                      //           min = size;
                      //           if(typeof(max) === 'undefined')
                      //             delta = size;
                      //           else
                      //             delta = (max-size)/2;
                      //         }
                      //         else {
                      //           max = size;
                      //           if(typeof(min) === 'undefined')
                      //             delta = -1*size/2;
                      //           else
                      //             delta = -1*(size-min)/2;
                      //         }
                      //         size += delta;
                      //
                      //         success = true;
                      //         try {
                      //           buf = String.fromCharCode.apply(null, new Uint8Array(size));
                      //           sendCommand({
                      //             command: 'test',
                      //             data: buf,
                      //           });
                      //         }
                      //         catch(e) {
                      //           success = false;
                      //         }
                      //       }
                      //
                      //       return size;
                      //     };
                      //
                      //     curry = function(obj, fn, args) {
                      //       return function() {
                      //         return obj[fn].apply(obj, args);
                      //       }
                      //     }
