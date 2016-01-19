var http = require('http');
var https = require('https');
var URL = require('url');
var Path = require('path');
var ContentDisposition = require('content-disposition');
var BufferList = require('bl');
var moment = require('moment');
var MediaTyper = require('media-typer');
var Dom = require('whacko');
var Exif = require('exiftool');
var debug = require('debug')('url-inspector');
var OEmbedProviders = require('oembed-providers-unofficial');

module.exports = inspector;

var inspectors = {
	embed: [inspectEmbed, Infinity],
	image: [inspectMedia, 30000],
	audio: [inspectMedia, 30000],
	video: [inspectMedia, 100000],
	link: [inspectHTML, 8000],
	file: [inspectFile, 100],
	archive: [inspectArchive, 0]
};

function inspector(url, opts, cb) {
	url = encodeURI(url);
	var obj = {
		url: url
	};
	var urlObj = URL.parse(url);
	urlObj.headers = {
		"User-Agent": "Mozilla/5.0"
	};
	debug("test url", url);

	var oEmbedUrl = supportsOEmbed(urlObj);
	if (oEmbedUrl) {
		debug("oembed candidate");
		urlObj = URL.parse(oEmbedUrl);
		obj.type = "embed";
		obj.mime = "text/html";
	}
	request(urlObj, obj, function(err, tags) {
		if (obj) {
			normalize(obj);
			if (!obj.site) obj.site = urlObj.domain;
			if (opts.all && tags) obj.all = tags;
		}
		cb(err, obj);
	});
}

function supportsOEmbed(urlObj, cb) {
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
	if (!provider) return false;
	// request oembed endpoint
	return endpoint.url + "?format=json&url=" + encodeURIComponent(url);
}

function request(urlObj, obj, cb) {
	debug("request url", urlObj.href);
	var req = (/^https:?$/.test(urlObj.protocol) ? https : http).request(urlObj, function(res) {
		var status = res.statusCode;
		debug("got response status %d", status);
		if (status < 200 || status >= 400) return cb(status);
		if (status >= 300 && status < 400 && res.headers.location) {
			var redirObj = URL.parse(res.headers.location);
			redirObj.redirects = (urlObj.redirects || 0) + 1;
			if (redirObj.redirects >= 5) return cb("Too many http redirects");
			return request(redirObj, obj, cb);
		}
		var mimeObj = MediaTyper.parse(res.headers['content-type']);
		if (obj.type == "embed") {
			obj.mime = "text/html";
			obj.type = "embed";
		} else {
			obj.mime = MediaTyper.format(mimeObj);
			obj.type = mime2type(mimeObj);
			obj.size = parseInt(res.headers['content-length']);
		}
		var disposition = res.headers['content-disposition'];
		if (disposition) {
			disposition = ContentDisposition.parse(disposition);
			if (disposition && disposition.params.file) {
				urlObj = URL.parse(disposition.params.file);
			}
		}
		obj.name = Path.basename(urlObj.path);

		debug("(mime, type, length) is (%s, %s, %d)", obj.mime, obj.type, obj.size);
		var fun = inspectors[obj.type];
		(function(next) {
			if (fun[1]) buffer(req, res, fun[1], next);
			else next();
		})(function(err, buf) {
			if (err) console.error(err);
			fun[0](obj, buf, function(err, tags) {
				if (err) console.error(err);
				cb(null, obj, tags);
			});
		});
	}).on('error', function(err) {
		return cb(err);
	});
	req.end();
}

function normalize(obj) {
	Object.keys(obj).forEach(function(key) {
		if (obj[key] == "" || obj[key] == null) delete obj[key];
	});
	if (obj.ext) obj.ext = obj.ext.toLowerCase();
}

function mime2type(obj) {
	var type = 'file';
	if (obj.subtype == "html") {
		type = 'link';
	} else if (['image', 'audio', 'video'].indexOf(obj.type) >= 0) {
		type = obj.type;
	} else if (['css', 'json', 'xml', 'plain'].indexOf(obj.subtype) >= 0) {
		type = 'file';
	} else if (obj.subtype == 'svg') {
		type = 'image';
	} else if (['x-xz', 'x-gtar', 'x-gtar-compressed',
	'x-tar', 'gzip', 'zip'].indexOf(obj.subtype) >= 0) {
		type = 'archive';
	}
	return type;
}

function buffer(req, res, length, cb) {
	var bl = new BufferList();
	res.on('data', function(buf) {
		bl.append(buf);
		if (bl.length >= length) {
			debug("got %d bytes, aborting", bl.length);
			req.abort();
		}
	});
	res.on('end', function(buf) {
		if (buf) bl.append(buf);
		debug("response ended, got %d bytes", bl.length);
		cb(null, bl.slice());
	});
	res.resume();

}

function importTags(tags, obj, map) {
	var val, tag, key, prev;
	if (!map) {
		// no map means all keys are already good
		map = {};
		for (key in tags) map[key] = key;
	}
	for (tag in map) {
		val = tags[tag];
		if (val === undefined) continue;
		delete tags[tag];
		key = map[tag];
		prev = obj[key];
		obj[key] = val;
	}
}

function importMeta(dom, map, obj) {
	var key, val;
	for (key in map) {
		val = dom('meta[name="' + map[key] + '"]').attr('content');
		if (val != null && val != "") obj[key] = val;
	}
}

function secondsToDuration(num) {
	var duration = moment.duration(parseInt(num), 'seconds');
	return moment(duration._data).format('HH:mm:ss');
}

function inspectMedia(obj, buf, cb) {
	Exif.metadata(buf, function(err, tags) {
		if (err) return cb(err);
		debug("exiftool got", tags);
		if (tags && tags.error) return cb(tags.error);
		if (!tags) return cb();
		importTags(tags, obj, {
			imageWidth: 'width',
			imageHeight: 'height',
			duration: 'duration',
			mimeType: 'mime',
			extension: 'ext',
			title: 'title',
			album: 'album',
			objectName: 'title'
		});
		if (tags.audioBitrate && !tags.duration) {
			var rate = parseInt(tags.audioBitrate) * 1000 / 8;
			obj.duration = secondsToDuration(obj.size / rate);
		}
		// copy to be able to serialize to JSON
		cb(null, Object.assign({}, tags));
	});
}

function inspectHTML(obj, buf, cb) {
	var dom = Dom.load(buf);
	var oembed = dom('link[type="application/json+oembed"]').attr('href');
	if (oembed) {
		obj.type = "embed";
		return request(URL.parse(oembed), obj, cb);
	}
	importTags({
		title: dom('title, h1').first().text(),
		icon: dom('link[rel="icon"],link[rel="shortcut icon"]').first().attr('href')
	}, obj);
	var oldType = obj.type;
	delete obj.type;
	importMeta(dom, {
		title: "og:title",
		thumbnail: "og:image",
		url: "og:url",
		type: "og:type",
		site: "og:site_name"
	}, obj);
	var ogType = obj.type;
	if (ogType) {
		if (ogType.startsWith('video')) obj.type = 'video';
		else if (ogType.startsWith('music')) obj.type = 'audio';
		else obj.type = 'link';
	} else {
		obj.type = oldType;
	}
	importMeta(dom, {
		title: "twitter:title",
		thumbnail: "twitter:image",
		url: "twitter:url",
		site: "twitter:site"
	}, obj);
	if (dom('meta[name="twitter:card"]').attr('content') == 'photo') obj.type = 'image';
	cb();
}

function inspectEmbed(obj, buf, cb) {
	var tags = JSON.parse(buf.toString());
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
}

function inspectFile(obj, buf, cb) {
	obj.sample = buf.toString().replace(/\s+/g, ' ').substring(0, 30);
	cb();
}

function inspectArchive(obj, buf, cb) {
	cb();
}

function inspectLink(obj, buf, cb) {
	cb();
}

