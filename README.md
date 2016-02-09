url-inspector
=============

Get metadata about any URL.

Limited memory and network usage.

This is a node.js module.

It returns and normalizes information found in http headers or in the resource
itself using exiftool (which knows almost everything about files but html),
or a sax parser to read oembed, opengraph, twitter cards, schema.org attributes
or standard html tags.

Both tools stop inspection when they gathered enough tags, or stop when they
reached a maximum value that depends on media type.

A [demo](http://inspector.eda.sarl) using this module is available,
with [url-inspector-daemon](http://github.com/kapouer/url-inspector-daemon)


* title  
  title of the resource, or filename, or last component of pathname with query

* site  
  the name of the site, or the domain name

* mime  
  the inspected mime type of the resource - could differ from server Content-Type

* ext  
  the extension matching the mime type

* type  
  what the resource represents  
  image, video, audio, link, file, embed, archive

* html  
  a canonical html representation of the full resource,  
  depending on the type and mime, could be img, a, video, audio, iframe tag.

* size  
  *optional* Content-Length of the resource

* icon  
  *optional* link to the favicon of the site

* width, height  
  *optional* dimensions

* duration  
  *optional*

* thumbnail  
  *optional* a URL to a thumbnail, could be a data-uri for embedded images

* embed  
  *optional* a URL that can be used in an iframe

* error  
  *optional* an http error code, or string

* all  
  an object with all additional metadata that was found


Installation
------------

```
npm install url-inspector
```

Add `-g` switch to install the executable.

exiftool executable must be available.

A package is available for debian/ubuntu: libimage-exiftool-perl
and for fedora: perl-Image-ExifTool.
Otherwise it is installable from
http://owl.phy.queensu.ca/~phil/exiftool/


API
---

```
var inspector = require('url-inspector');

var opts = {
	all: true // return all available non-normalized metadata
};

inspector(url, opts, function(err, obj) {

});

// or simply

inspector(url, function(err, obj) {...});

```

Command-line client
-------------------

```
inspector-url <url>
```

Low resource usage
------------------

network:

- a maximum of several hundreds of bytes (depending on resource type) is downloaded
- inspection stops as soon as enough metadata is gathered

memory:
- html is inspected using a sax parser, without building a full DOM.

exiftool:
- run using `streat` module, which keeps exiftool always open for smaller delays


License
-------

See LICENSE.


See also
--------

https://github.com/kapouer/url-inspector-daemon
https://github.com/kapouer/node-streat

