var http = require('http');
var httpAgent = new http.Agent({});
var https = require('https');
var httpsAgent = new https.Agent({ rejectUnauthorized: false });
var URL = require('url');
var Path = require('path');
var ContentDisposition = require('content-disposition');
var BufferList = require('bl');
var moment = require('moment');
var MediaTyper = require('media-typer');
var dataUri = require('strong-data-uri');
var mime = require('mime');
var SAXParser = require('parse5').SAXParser;
var debug = require('debug')('url-inspector');
var OEmbedProviders = require('oembed-providers');
var Streat = require('streat');

var streat = new Streat();
streat.start();

module.exports = inspector;

// maximum bytes to download for each type of data
var inspectors = {
	embed: [inspectEmbed, 10000],
	svg: [inspectSVG, 30000],
	image: [inspectMedia, 30000],
	audio: [inspectMedia, 200000],
	video: [inspectMedia, 100000],
	link: [inspectHTML, 150000],
	file: [inspectFile, 32000],
	archive: [inspectArchive, 0]
};

function inspector(url, opts, cb) {
	if (typeof opts == "function" && !cb) {
		cb = opts;
		opts = null;
	}
	if (!opts) {
		opts = {};
	}
	var obj = {
		url: encodeURI(url)
	};

	var urlObj = URL.parse(obj.url);
	urlObj.headers = {
		"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.111 Safari/537.36"
	};

	var oEmbedUrl = opts.noembed ? {} : supportsOEmbed(urlObj);
	if (!oEmbedUrl.discovery && oEmbedUrl.url) {
		debug("oembed candidate");
		oEmbedUrl.obj = URL.parse(oEmbedUrl.url);
		obj.type = "embed";
		obj.mime = "text/html";
	}
	if (opts.noembed) obj.noembed = true;
	if (opts.error) obj.error = opts.error;
	request(oEmbedUrl.obj || urlObj, obj, function(err, tags) {
		if (err) {
			if (oEmbedUrl.obj) {
				return inspector(url, Object.assign({noembed: true, error: err}, opts), cb);
			} else {
				return cb(err);
			}
		}
		if (!obj) return cb(400);
		if (!obj.site) {
			obj.site = urlObj.hostname;
		}
		normalize(obj);
		if (opts.all && tags) obj.all = tags;
		var urlFmt = URL.format(urlObj);
		if (obj.thumbnail) {
			obj.thumbnail = URL.resolve(urlFmt, obj.thumbnail);
		}
		if (obj.icon) {
			obj.icon = URL.resolve(urlFmt, obj.icon);
			cb(null, obj);
		} else if (obj.mime == "text/html") {
			var iconObj = {
				hostname: urlObj.hostname,
				port: urlObj.port,
				protocol: urlObj.protocol,
				pathname: '/favicon.ico'
			};
			remoteExists(iconObj, function(yes) {
				if (yes) obj.icon = URL.format(iconObj);
				cb(null, obj);
			});
		} else {
			var iobj = {
				onlyfavicon: true
			};
			var urlObjRoot = {
				hostname: urlObj.hostname,
				port: urlObj.port,
				protocol: urlObj.protocol
			};
			request(urlObjRoot, iobj, function(err) {
				if (err) console.error(err);
				if (iobj.icon) obj.icon = URL.resolve(URL.format(urlObjRoot), iobj.icon);
				cb(null, obj);
			});
		}
	});
}

function supportsOEmbed(urlObj, cb) {
	var ret = {};
	var endpoint;
	var url = urlObj.href;
	var provider = OEmbedProviders.find(function(provider) {
		endpoint = provider.endpoints.find(function(point) {
			if (!point.schemes) return false;
			return !!point.schemes.find(function(scheme) {
				return new RegExp("^" + scheme.replace("*", ".*") + "$").test(url);
			});
		});
		return !!endpoint;
	});
	if (!provider) {
		return ret;
	}
	// request oembed endpoint
	var formatted = false;
	var epUrl = endpoint.url.replace('{format}', function() {
		formatted = true;
		return 'json';
	});
	var epUrlObj = URL.parse(epUrl, true);
	if (!formatted) epUrlObj.query.format = 'json';
	epUrlObj.query.url = url;
	delete epUrlObj.search;
	ret.url = URL.format(epUrlObj);
	ret.discovery = !!endpoint.discovery;
	return ret;
}

function remoteExists(urlObj, cb) {
	var opts = Object.assign({}, urlObj);
	opts.method = 'HEAD';
	var req = (/^https:?$/.test(urlObj.protocol) ? https : http)
	request(opts, function(res) {
		var status = res.statusCode;
		debug("remote", URL.format(urlObj), "returns", status);
		req.abort();
		if (status >= 200 && status < 400) return cb(true);
		else return cb(false);
	});
	req.end();
}

function request(urlObj, obj, cb) {
	if (!urlObj.href) urlObj.href = URL.format(urlObj);
	debug("request url", urlObj.href);
	var opts = Object.assign({}, urlObj);
	var secure = /^https:?$/.test(urlObj.protocol);
	opts.agent = secure ? httpsAgent : httpAgent;
	var req = (secure ? https : http).request(opts, function(res) {
		var status = res.statusCode;
		res.pause();
		debug("got response status %d", status);
		if (status < 200 || status >= 400 || status == 303) return cb(status);
		if (status >= 300 && status < 400 && res.headers.location) {
			req.abort();
			var location = URL.resolve(urlObj.href, res.headers.location);
			var redirObj = URL.parse(location);
			redirObj.headers = urlObj.headers;
			redirObj.redirects = (urlObj.redirects || 0) + 1;
			if (redirObj.redirects >= 5) return cb("Too many http redirects");
			return request(redirObj, obj, cb);
		}

		var contentType = res.headers['content-type'];
		if (!contentType) contentType = mime.lookup(Path.basename(urlObj.pathname));
		var mimeObj = MediaTyper.parse(contentType);
		if (obj.type == "embed") {
			obj.mime = "text/html";
			obj.type = "embed";
		} else {
			obj.mime = MediaTyper.format(mimeObj);
			obj.type = mime2type(mimeObj);
		}

		var contentLength = res.headers['content-length'];
		if (contentLength != null) {
			obj.size = parseInt(contentLength);
		}
		var disposition = res.headers['content-disposition'];
		if (disposition != null) {
			disposition = ContentDisposition.parse(disposition);
			if (disposition && disposition.parameters.filename) {
				urlObj = URL.parse(disposition.parameters.filename);
			}
		}
		if (obj.title == null) obj.title = Path.basename(urlObj.path);

		debug("(mime, type, length) is (%s, %s, %d)", obj.mime, obj.type, obj.size);
		var fun = inspectors[obj.type];
		pipeLimit(req, res, fun[1]);
		fun[0](obj, res, function(err, tags) {
			if (err) console.error(err);
			req.abort();
			// request oembed when
			// - not blacklisted (noembed)
			// - has already or has found a oembed url
			// - does not have a thumbnail or does not have an html embed code,
			var fetchEmbed = !obj.noembed && obj.oembed && (!obj.thumbnail || (!obj.html && !obj.embed));
			delete obj.noembed;
			if (fetchEmbed) {
				obj.type = "embed";
				// prevent loops
				obj.noembed = true;
				request(URL.parse(obj.oembed), obj, cb);
			} else {
				cb(null, obj, tags);
			}
		});
	}).on('error', function(err) {
		return cb(err);
	});
	req.end();
}

function normalize(obj) {
	// remove all empty keys
	Object.keys(obj).forEach(function(key) {
		var val = obj[key];
		if (val == "" || val == null || (typeof val == 'number' && isNaN(val))) delete obj[key];
	});

	if (!obj.ext) {
		obj.ext = mime.extension(obj.mime);
	}
	obj.ext = obj.ext.toLowerCase();
	switch(obj.ext) {
		case "jpeg":
			obj.ext = "jpg";
			break;
		case "mpga":
			obj.ext = "mp3";
			break;
	}

	if (obj.duration) {
		obj.duration = formatDuration(moment.duration(obj.duration));
	}

	if (obj.site.startsWith('@')) obj.site = obj.site.substring(1);
	obj.site = obj.site.toLowerCase();

	var alt = encodeURI(obj.title);

	if (!obj.html) {
		if (obj.embed) {
			obj.html = `<iframe src="${obj.embed}"></iframe>`;
		} else  if (obj.type == "image") {
			obj.html = `<img src="${obj.url}" alt="${alt}" />`;
		} else if (obj.type == "video") {
			obj.html = `<video src="${obj.url}"></video>`;
		} else if (obj.type == "audio") {
			obj.html = `<audio src="${obj.url}"></audio>`;
		} else if (obj.type == "embed") {
			obj.html = `<iframe src="${obj.url}"></iframe>`;
		} else if (obj.type == "link") {
			obj.html = `<a href="${obj.url}">${obj.title}</a>`;
		} else if (obj.type == "file" || obj.type == "archive") {
			obj.html = `<a href="${obj.url}" target="_blank">${obj.title}</a>`;
		}
	}
	if (obj.oembed) delete obj.oembed;
}

function mime2type(obj) {
	var type = 'file';
	if (obj.subtype == "html") {
		type = 'link';
	} else if (obj.subtype == 'svg') {
		type = 'svg';
	} else if (['image', 'audio', 'video'].indexOf(obj.type) >= 0) {
		type = obj.type;
	} else if (['x-xz', 'x-gtar', 'x-gtar-compressed',
	'x-tar', 'gzip', 'zip'].indexOf(obj.subtype) >= 0) {
		type = 'archive';
	}
	return type;
}

function pipeLimit(req, res, length) {
	if (!length) return req.abort();
	var curLength = 0;
	res.on('data', function(buf) {
		curLength += buf.length;
		if (curLength >= length) {
			debug("got %d bytes, aborting", curLength);
			req.abort();
		}
	});
}

function importTags(tags, obj, map) {
	var val, tag, itag, key;
	for (var tag in tags) {
		val = tags[tag];
		if (val == null) continue;
		itag = tag.toLowerCase();
		key = map ? map[itag] : itag;
		if (key === undefined) continue;
		delete tags[tag];
		obj[key] = val;
	}
}

function formatDuration(mom) {
	return moment(mom._data).format('HH:mm:ss');
}

function inspectHTML(obj, res, cb) {
	// collect tags
	var selectors = {
		title: {
			priority: 1,
			text: "title"
		},
		link: {
			priority: 2,
			rel: {
				icon: "icon",
				'shortcut icon': "icon",
			},
			type: {
				"application/json+oembed": "oembed"
			}
		},
		meta: {
			priority: 3,
			property: {
				'og:title': "title",
				'og:image': "thumbnail",
				'og:url': "url",
				'og:type': "type",
				'og:site_name': "site",
				'og:video:url': "embed",
				'og:audio:url': "embed"
			},
			name: {
				'twitter:title': "title",
				'twitter:image': "thumbnail",
				'twitter:url': "url",
				'twitter:site': "site",
				'twitter:type': "type"
			},
			itemprop: {
				name: "title",
				duration: "duration",
				thumbnailurl: "thumbnail",
				embedurl: "embed",
				width: "width",
				height: "height"
			}
		}
	};

	var parser = new SAXParser();
	var tags = {};
	var priorities = {};
	var curText, curKey, curPriority;
	var curSchemaType, curSchemaLevel;
	var firstSchemaType, firstSchemaLevel;
	var curLevel = 0;
	var embedType;

	parser.on('startTag', function(name, atts, selfClosing) {
		if (name == "meta" || name =="link") selfClosing = true;
		if (!selfClosing) curLevel++;
		if (curSchemaType && curSchemaLevel < curLevel) return;
		var i, att, attmap, valmap, key, nkey, name = name.toLowerCase(), val, attsObj = {};
		if (selectors[name] && selectors[name].text) {
			key = selectors[name].text;
		} else for (i=0; i < atts.length; i++) {
			att = atts[i];
			val = att.value;
			if (!val) continue;

			if (att.name == "itemtype") {
				if (/\/.*(Action|Event|Page|Site|Type|Status|Audience)$/.test(val)) continue;

				debug("schema type", val);

				// the page can declares several itemtype
				// the order in which they appear is important
				// nonWebPage + embedType -> ignore embedType
				// WebPage (or nothing) + embedType -> embedType is the type of the page
				curSchemaType = val;
				curSchemaLevel = curLevel;
				if (!firstSchemaType) {
					firstSchemaType = curSchemaType;
					firstSchemaLevel = curSchemaLevel;
					tags.type = val;
				}
				continue;
			} else if (att.name == "itemprop") {
				attmap = selectors.meta;
			} else {
				attsObj[att.name] = val;
				attmap = selectors[name];
				if (!attmap) continue;
			}
			valmap = attmap[att.name];
			if (!valmap) continue;
			nkey = valmap[val.toLowerCase()];
			if (nkey) key = nkey;
		}
		if (!key) return;
		var mkey;
		if (name == "meta") mkey = 'content';
		else if (name == "link") mkey = 'href';
		else if (!selfClosing) {
			curKey = key;
			curText = "";
			return;
		}
		var priority = curPriority = selectors[name] && selectors[name].priority || 0;
		debug("Tag", name, "has key", key, "with priority", priority, "and value", attsObj[mkey], "in attribute", mkey);
		if (mkey && attsObj[mkey] && (!priorities[key] || priority > priorities[key])) {
			priorities[key] = priority;
			tags[key] = attsObj[mkey];
			if (key == "icon" && obj.onlyfavicon) {
				finish();
			}
		}
	});
	parser.on('text', function(text) {
		if (curText != null) curText += text;
	});
	parser.on('endTag', function(name) {
		if (curSchemaLevel == curLevel) {
			// we finished parsing the content of an embedded Object, abort parsing
			curSchemaLevel = null;
			curSchemaType = null;
			return finish();
		}
		curLevel--;
		if (curText != null && (!priorities[curKey] || curPriority > priorities[curKey])) {
			debug("Tag", name, "has key", curKey, "with text content", curText);
			tags[curKey] = curText;
		}
		curText = null;
		curKey = null;
	});


	res.once('end', finish);

	var finished = false;
	function finish() {
		if (finished) return;
		finished = true;
		parser.stop();
		var type = tags.type;
		if (type) {
			if (/(^|\/)(video|movie)/i.test(type)) type = 'video';
			else if (/(^|\/)(audio|music)/i.test(type)) type = 'audio';
			else if (/(^|\/)(image|photo)/i.test(type)) type = 'image';
			else type = null;
			if (type) obj.type = type;
			delete tags.type;
		}
		Object.assign(obj, tags);
		cb();
	}

	res.pipe(parser);
}

function inspectEmbed(obj, res, cb) {
	res.pipe(BufferList(function(err, data) {
		if (err) return cb(err);
		var tags = JSON.parse(data.toString());
		importTags(tags, obj, {
			type: 'type',
			title: 'title',
			thumbnail_url: 'thumbnail',
			width: 'width',
			height: 'height',
			html: 'html',
			url: 'url',
			provider_name: 'site'
		});
		if (obj.type == "photo") obj.type = "image";
		else if (obj.type == "rich") obj.type = "embed";
		cb(null, tags);
	}));
}

function inspectSVG(obj, res, cb) {
	var parser = new SAXParser();
	parser.on('startTag', function(name, atts, selfClosing) {
		if (name != "svg") return;
		obj.type = "image";
		var box = atts.find(function(att) {
			return att.name.toLowerCase() == "viewbox";
		}).value;
		if (!box) return cb();
		var parts = box.split(/\s+/);
		if (parts.length == 4) {
			obj.width = parseFloat(parts[2]);
			obj.height = parseFloat(parts[3]);
		}
		cb();
	});
	res.pipe(parser);
}

function inspectMedia(obj, res, cb) {
	streat.run(res, function(err, tags) {
		if (err) return cb(err);
		importTags(tags, obj, {
			imagewidth: 'width',
			imageheight: 'height',
			duration: 'duration',
			mimetype: 'mime',
			extension: 'ext',
			title: 'title',
			artist: 'artist',
			album: 'album',
			objectname: 'title',
			audiobitrate: 'bitrate'
		});
		if (!obj.thumbnail && tags.Picture && tags.PictureMIMEType) {
			obj.thumbnail = dataUri.encode(
				new Buffer(tags.Picture.replace(/^base64:/, ''), 'base64'),
				tags.PictureMIMEType
			);
		}
		if (obj.bitrate && !obj.duration) {
			var rate = parseInt(obj.bitrate) * 1000 / 8;
			obj.duration = moment.duration(parseInt(obj.size / rate), 'seconds');
		}
		delete obj.bitrate;
		if (obj.title && obj.artist && obj.title.indexOf(obj.artist) < 0) {
			obj.title = obj.title + ' - ' + obj.artist;
			delete obj.artist;
		}
		// copy to be able to serialize to JSON
		cb(null, tags);
	});
}

function inspectFile(obj, res, cb) {
	streat.run(res, function(err, tags) {
		if (err) return cb(err);
		importTags(tags, obj, {
			mimetype: 'mime',
			extension: 'ext',
			filetypeextension: 'ext',
			title: 'title'
			//,pagecount: 'pages'
		});
		cb(null, tags);
	});
}

function inspectArchive(obj, res, cb) {
	cb(null, obj);
}

