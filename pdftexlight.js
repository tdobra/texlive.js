//Restricted version of texlive.js containing only what is required for TCTemplate (no BibTeX)
//Class instances persist, but Emscripten worker can only be run once, so must reload each time
//Await ready promise, then await compile promise, then loop - do not await ready while compile is running

"use strict";

class TeXLive {
  constructor(obj) {
    //Private properties
    this.worker = undefined;
    this.onlog = obj.onlog;
    addEventListener("unload", () => { this.terminate(); });
    //Public functions
    this.createCmd("FS_createDataFile"); // parentPath, filename, data, canRead, canWrite
    this.createCmd("FS_readFile"); // filename
    //Private functions
    this.createCmd("FS_createPath"); // parent, name, canRead, canWrite
    this.createCmd("set_TOTAL_MEMORY"); // size
    //Public properties
    this.ready = this.prestart();  //Returns a promise
  }

  static arrayBufferToString(buffer) {
    //Converts array buffer to binary string
    //Trying to do this using function.apply causes stack overflow - use for loop instead
    const byteArray = new Uint8Array(buffer);
    let binaryString = "";
    for (let byteId = 0; byteId < byteArray.length; byteId++) {
      binaryString += String.fromCharCode(byteArray[byteId]);
    }
    return binaryString;
  }

  async compile(src, resourceStrings = [], resourceNames = []) {
    //src is URL of TeX document to run
    //resourceBuffers is an array of ArrayBuffers of additional input files with corresponding names in resourceNames
    let binary_pdf;
    try {
      try {
        await this.orError(this.ready);
        //Upload input files to Emscripten file system
        await this.orError(Promise.all(
          resourceStrings.map(
            //TODO: Trying with write permissions
            (rString, index) => this.FS_createDataFile("/", resourceNames[index], rString, true, false)
          ).concat(
            this.FS_createDataFile("/", "input.tex", await TeXLive.getFile(src), true, false)
          )
        ));
        await this.orError(this.sendCmd({
          "command": "run",
          "arguments": ["-interaction=nonstopmode", "-output-format", "pdf", "input.tex"]
        }));
        binary_pdf = await this.orError(this.FS_readFile("input.pdf"));
      } finally {
        //Reset system
        this.terminate();
        //Ready is reset to new promise before compile promise resolves
        this.ready = this.prestart();
      }
    } catch (err) { throw err; }

    //Return data URL
    if (binary_pdf === false) { throw new Error("PDF failed to compile"); }
    const outBlob = new Blob([binary_pdf], { type: "application/pdf" });
    return URL.createObjectURL(outBlob);
    // return "data:application/pdf;charset=binary;base64," + btoa(binary_pdf);
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

  async orError(cmdPromise) {
    //Use await this.orError(cmd) to also check for errors thrown by worker, which will cause this.workerError to reject
    //Apply to awaits of FS_* and sendCmd
    const promises = [cmdPromise];
    if (this.workerError !== undefined) { promises.push(this.workerError); }
    try {
      return await Promise.race(promises);
    } catch (err) {
      if (typeof err === "string") {
        throw new Error(err);
      } else {
        throw err;
      }
    }
  }

  async prestart() {
    //Initiate file downloads
    const workerSrc = TeXLive.getFile(TeXLive.workerFolder + "pdftex-worker.js");
    const packagesProm = TeXLive.getPackages();

    //Start worker
    const workerProm = new Promise((resolve) => { this.workerReady = resolve; });
    this.workerError = new Promise((resolve, reject) => { this.workerOnError = reject; });
    this.cmdResolves = [];
    this.worker = new Worker(await workerSrc);
    //Make sure event handler uses this to refer to TeXLive instance
    this.worker.addEventListener("message", (ev) => { this.handleMsg(ev); });
    this.worker.addEventListener("error", (ev) => {
      // ev.preventDefault();
      this.workerOnError("Worker: " + ev.message);
    });
    await this.orError(workerProm);

    //Set memory
    const memSize = 80 * 1024 * 1024;
    const availableSize = await this.orError(this.set_TOTAL_MEMORY(memSize));
    if (availableSize < memSize) { console.warn("Memory limited to " + availableSize.toString() + "B"); }

    //Add folders then files to emscripten
    const packages = await packagesProm;
    //Folders are created recursively
    const folderRtns = await this.orError(Promise.all(packages.folders.map((folder) => this.FS_createPath("/", folder, true, true))));
    if (!folderRtns.every((val) => val === true)) { throw new Error("Failed to create folders in Emscripten"); }
    //TODO: Write permissions only for debugging - change to read only
    // const tmp = packages.files.map((file) => )
    // const tmp = await TeXLive.getFile(packages.files[0].fullurl);
    // await this.orError(Promise.all(packages.files.map(async (file) => this.FS_createDataFile(file.path, file.name, tmp, true, false))));

    const fileRtns = await this.orError(Promise.all(packages.files.map(async (file) => this.FS_createDataFile(file.path, file.name, await TeXLive.getFile(file.fullurl), true, false))));
    if (!fileRtns.every((val) => val === true)) { throw new Error("Failed to create files in Emscripten"); }

    // const filesVer = await this.orError(Promise.all(packages.files.map((file) => this.FS_readFile(file.path + "/" + file.name))));
  }

  async sendCmd(cmd) {
    const prom = new Promise((resolve) => {
      const msg_id = this.cmdResolves.push(resolve) - 1;
      cmd.msg_id = msg_id;
    });
    await this.orError(this.workerReady);
    this.worker.postMessage(JSON.stringify(cmd));
    return prom;
  };
}

//Static properties on class - to be only run once. Static properties in class are not yet fully supported.
TeXLive.workerFolder = ""; //To be set relative to calling webpage

TeXLive.getFile = (() => {
  //Download and store each required source file
  const contents = {};

  async function download(path) {
    const fileFetch = await fetch(path);
    if (!fileFetch.ok) { throw new Error("Could not download file " + path + ": " + fileFetch.status); }
    //Store data according to file extension
    switch (path.slice(path.lastIndexOf(".") + 1)) {
    case "js":
      //Web workers need a data URL
      return URL.createObjectURL(await fileFetch.blob());
      break;
    case "lst":
      return await fileFetch.text();
      break;
    default:
      //Assume binary file - convert to binary string
      return TeXLive.arrayBufferToString(await fileFetch.arrayBuffer());
    }
  }

  return async (path) => {
    //Beware of race conditions - get downloads via promise, so this function executes in entirity in one, as JS is single threaded
    if (contents[path] === undefined) { contents[path] = download(path); }
    return await contents[path];
  };
})();

TeXLive.getPackages = (() => {
  const folders = [];
  const files = [];

  return async () => {
    if (files.length === 0) {
      //Load TeXLive file list
      const packageList = await TeXLive.getFile(TeXLive.workerFolder + "texlivelight.lst");

      //List of URLs. Remove last element as blank.
      const urlList = packageList.split("\n");
      urlList.pop();

      //Read and sort the list
      for (const url of urlList) {
        const lastSeparator = url.lastIndexOf("/");
        let path;
        if (lastSeparator === -1) {
          path = "";
        } else {
          path = url.slice(0, lastSeparator);
        }
        //Path and name do not include the / separating them
        if (url.endsWith(".")) {
          folders.push(path);
        } else {
          files.push({
            fullurl: TeXLive.workerFolder + "texlive/" + url,
            path: path,
            name: url.slice(lastSeparator + 1)
          });
        }
      }
    }

    return {
      folders: folders,
      files: files
    };
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
