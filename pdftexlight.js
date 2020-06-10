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
    this.createCmd("FS_createDataFile"); // parentPath, filename, data as binary string, canRead, canWrite
    this.createCmd("FS_readFile"); // filename; returns binary string
    //Private functions
    this.createCmd("FS_createPath"); // parent, name, canRead, canWrite
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

  static binaryStringToU8Array(binaryString) {
    const arrayLength = binaryString.length
    const byteArray = new Uint8Array(arrayLength);
    for (let byteId = 0; byteId < arrayLength; byteId++) {
      byteArray[byteId] = binaryString.charCodeAt(byteId);
    }
    return byteArray;
  }

  async compile(src, resourceStrings = [], resourceNames = []) {
    //src is URL of TeX document to run
    //resourceStrings is an array of binary strings of additional input files with corresponding names in resourceNames
    let pdfURL;
    try {
      try {
        await this.orError(this.ready);
        //Upload input files to Emscripten file system
        await this.orError(Promise.all(
          resourceStrings.map(
            (rString, index) => this.FS_createDataFile("/", resourceNames[index], rString, true, false)
          ).concat(
            this.FS_createDataFile("/", "input.tex", await TeXLive.getFile(src), true, false)
          )
        ));
        await this.orError(this.sendCmd({
          "command": "run",
          "arguments": ["-interaction=nonstopmode", "-output-format", "pdf", "input.tex"]
        }));
        await this.compileProm;
        const binary_pdf = await this.orError(this.FS_readFile("input.pdf"));
        //Return data URL
        const outBlob = new Blob([TeXLive.binaryStringToU8Array(binary_pdf)], { type: "application/pdf" });
        pdfURL = URL.createObjectURL(outBlob);
      } finally {
        //Reset system
        this.terminate();
        //Ready is reset to new promise before compile promise resolves
        this.ready = this.prestart();
      }
    } catch (err) {
      throw err;
    }
    return pdfURL;
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
      try {
        const msg = data.contents;
        this.onlog(msg);
        //Won't reach here if onlog throws an error
        if (msg.startsWith("Output written")) {
          this.compilePromResolve();
        } else if (msg.includes("no output PDF file produced")) {
          throw new Error("PDF failed to compile");
        }
      } catch (err) {
        this.compilePromReject(err);
      }
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

    //Read TeXLive log and resolve/reject promise to compile
    this.compileProm = new Promise((resolve, reject) => {
      this.compilePromResolve = resolve;
      this.compilePromReject = reject;
    });

    //Start worker
    const workerProm = new Promise((resolve) => { this.workerReady = resolve; });
    this.workerError = new Promise((resolve, reject) => { this.workerOnError = reject; });
    this.cmdResolves = [];
    this.worker = new Worker(await workerSrc);
    //Make sure event handler uses this to refer to TeXLive instance
    this.worker.addEventListener("message", (ev) => { this.handleMsg(ev); });
    this.worker.addEventListener("error", (ev) => { this.workerOnError("Worker: " + ev.message); });
    await this.orError(workerProm);

    //Set memory? Don't bother as appears to have no effect

    //Add folders then files to emscripten
    const packages = await packagesProm;
    //Folders are created recursively
    const folderRtns = await this.orError(Promise.all(packages.folders.map((folder) => this.FS_createPath("/", folder, true, true))));
    if (!folderRtns.every((val) => val === true)) { throw new Error("Failed to create folders in Emscripten"); }
    const fileRtns = await this.orError(Promise.all(packages.files.map(async (file) => this.FS_createDataFile(file.path, file.name, await TeXLive.getFile(file.fullurl), true, false))));
    if (!fileRtns.every((val) => val === true)) { throw new Error("Failed to create files in Emscripten"); }
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
      //Assume binary file, but safe on all files - convert to binary string
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
