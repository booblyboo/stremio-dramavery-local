
const pUrl = require('url')

const { config, proxy, persist } = require('internal')

const needle = require('needle')
const cheerio = require('cheerio')
const async = require('async')
const { scrape } = require('./lib/scraper')

const defaults = {
	name: 'Drama Very',
	prefix: 'dramavery_',
	origin: '',
	endpoint: 'https://dramavery.com',
	icon: 'https://www.viewasian.tv/themes/ViewAsian/images/logo.png',
	categories: []
}

let endpoint = defaults.endpoint

const episodes = {}

const videoUrls = {}

const headers = {
	'accept': 'application/json, text/plain, */*',
	'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
	'referer': endpoint,
	'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.103 Safari/537.36'
}

function setEndpoint(str) {
	if (str) {
		let host = str
		if (host.endsWith('/index.php'))
			host = host.replace('/index.php', '/')
		if (!host.endsWith('/'))
			host += '/'
		endpoint = host
		const origin = endpoint.replace(pUrl.parse(endpoint).path, '')
		headers['origin'] = origin.slice(0, -1)
		headers['referer'] = endpoint
	}
	return true
}

setEndpoint(defaults.endpoint)

function retrieveManifest() {
	function manifest() {
		return {
			id: 'org.' + defaults.name.toLowerCase().replace(/[^a-z]+/g,''),
			version: '1.0.0',
			name: defaults.name,
			description: 'Free Korean, Chinese, HK, Thailand movies and series.',
			resources: ['stream', 'meta', 'catalog', 'subtitles'],
			types: ['series', 'asian'],
			idPrefixes: [defaults.prefix],
			icon: defaults.icon,
			catalogs: [
				{
					id: defaults.prefix + 'catalog',
					type: 'asian',
					name: defaults.name,
					genres: ['movie', 'drama', 'kshow', 'korean', 'chinese', 'hk drama', 'thailand'],
					extra: [{ name: 'genres' }, { name: 'skip' }, { name: 'search' }]
				}
			]
		}
	}

	return new Promise((resolve, reject) => {
		resolve(manifest())
	})
}

const subtitles = []

const dbs = {}

let metas = {}

async function retrieveRouter() {

	const manifest = await retrieveManifest()

	const { addonBuilder, getInterface, getRouter } = require('stremio-addon-sdk')

	const builder = new addonBuilder(manifest)

	builder.defineCatalogHandler(args => {
		return new Promise(async (resolve, reject) => {
			const extra = args.extra || {}
			if (extra.search) {
				const sHeaders = JSON.parse(JSON.stringify(headers))
				sHeaders['x-requested-with'] = 'XMLHttpRequest',
				sHeaders['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
				needle.post(defaults.endpoint + '/ajax/film/search/', { query: extra.search }, { headers: sHeaders }, (err, resp, body) => {
					if (!err && (((body || {}).suggestions || []).length)) {
						const results = []
						body.suggestions.forEach(el => {
							const poster = el.image
							const id = el.image.split('/')[4]
							metas[id] = {
								id: defaults.prefix + id,
								name: el.vietnam || el.english + (el.year ? el.year.replace('&nbsp', ' ') : ''),
								poster,
								background: poster.replace('/poster/', '/banner/').replace('?type=small', '?type=banner'),
								type: 'series',
								href: el.link
							}
							results.push(metas[id])
						})
						resolve({ metas: results })
					} else {
						reject(defaults.name + ' - No results or unexpected response from search api')
					}
				})
			} else {
				const genre = extra.genre || 'drama'
				const skip = parseInt(extra.skip || 0)
				let page
				if (skip)
					page = (skip / 48) + 1
				const tag = genre + (skip ? ':' + page : '')
				if (!dbs[tag]) {
					needle.get(defaults.endpoint + '/' + genre + '/' + (skip ? 'page-' +page + '/' : ''), { headers }, (err, resp, body) => {
						if (!err && body) {
							const $ = cheerio.load(body)
							const results = []
							$('.col-xlg-2 .item .inner').each((ij, el) => {
								const poster = $(el).find('img').attr('src')
								const id = poster.split('/')[4]
								metas[id] = {
									id: defaults.prefix + id,
									name: $(el).attr('title'),
									poster,
									background: poster.replace('/poster/', '/banner/').replace('?type=small', '?type=banner'),
									href: $(el).attr('href'),
									type: 'series'
								}
								results.push(id)
							})
							if (results.length) {
								dbs[tag] = results
								resolve({ metas: results.map(id => { return metas[id] || {} }), cacheMaxAge: 86400 })
							} else
								reject(defaults.name + ' - Unexpected catalog response')
						} else
							reject(defaults.name + ' - Invalid catalog response')
					})
				} else {
					resolve({ metas: dbs[tag].map(id => { return metas[id] || {} }), cacheMaxAge: 86400 })
				}
			}
		})
	})

	builder.defineMetaHandler(args => {
		return new Promise(async (resolve, reject) => {
			let id = args.id.replace(defaults.prefix, '')
			if (metas[id]) {
				if ((metas[id].videos || []).length)
					resolve({ meta: metas[id] })
				else {
					needle.get(metas[id].href + 'watch/', { headers }, (err, resp, body) => {
						if (!err && body) {
							const $ = cheerio.load(body)
							const eps = []
							let releasedTime = Date.now()
							$('a.btn.btn-rounded').each((ij, el) => {
								const epNum = $(el).text().trim()
								if (!isNaN(epNum)) {
									const ep = parseInt(epNum)
									releasedTime -= 86400000
									episodes[args.id + ':1:' + ep] = $(el).attr('href')
									eps.push({
										season: 1,
										number: ep,
										name: 'Episode ' + ep,
										released: new Date(releasedTime).toISOString()
									})
								}
							})
							metas[id].videos = eps
							resolve({ meta: metas[id] })
						} else {
							reject(defaults.name + ' - Could not get videos for meta')
						}
					})
				}
			} else
				reject(defaults.name + ' - Could not get meta')
		})
	})

	builder.defineStreamHandler(args => {
		return new Promise(async (resolve, reject) => {
			let videoHref = episodes[args.id]
			if (videoHref) {
				needle.get(videoHref, { headers }, (err, resp, body) => {
					if (!err && body) {
						const $ = cheerio.load(body)
						let iframeHref = $('iframe#player-content').attr('src')
						if (iframeHref.startsWith('//'))
							iframeHref = 'https:' + iframeHref
						if (iframeHref) {

							function getKvid(cb) {
								const phantom = require('phantom')

							    phantom.load({
							        clearMemory: true,
							        agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36',
							        headers: {
							        	referer: videoHref,
							        	origin: endpoint
							        }
							    }, null, null, function(phInstance, page) {

							        let kVid = false
							        let secondUrl = false

									page.on('onResourceRequested', function(req, netReq) {
										if (!kVid && (req.url.includes('/streaming.php') || req.url.includes('/embed.php'))) {
											kVid = req.url
										} else if (!secondUrl && req.url.includes('player?url=')) {
											secondUrl = req.url
										}
									})
							        page.open(iframeHref).then(async (status, body) => {
							        	if (!kVid && secondUrl && secondUrl != iframeHref) {
							        		iframeHref = secondUrl
							        		phantom.close(phInstance, page, () => {
							        			getKvid(cb)
							        		})
							        	} else if (!kVid) {
							        		// i doubt this particular part ever worked
							        		// but.. meh
							        		page.evaluate(function() {
							        			return $('iframe.iframe-video').attr('src')
							        		}).then(inf => {
									            phantom.close(phInstance, page, () => {})
							        			cb(inf || false)
							        		}).catch(function(err) {
									            phantom.close(phInstance, page, () => {})
							        			cb(false)
							        		})
							        	} else {
								            phantom.close(phInstance, page, () => {})
								        	cb(kVid)
								        }
							        }, function(err) {
							        	console.log(defaults.name + ' phantomjs error:')
							        	console.log(err)
							            cb(false)
							            phantom.close(phInstance, page, () => {})
							        })
							    })

							}
						    getKvid(nextIframe => {
						    	if (nextIframe)
									needle.get(nextIframe, { headers }, (err, resp, body) => {
										if (!err && body) {
											const $ = cheerio.load(body)
											let streams = []
											const matches = body.match(/sources:[^\n]*/gm)
											const directSources = []
											matches.forEach(el => {
												let obj
												try {
													obj = JSON.parse(el.replace('sources:', '').slice(0, -1).split('file:').join('"file":').split('label:').join('"label":').split("'").join('"'))
												} catch(e) {}
												if (obj && Array.isArray(obj))
													obj.forEach(objEl => {
														if (objEl.file && directSources.indexOf(objEl.file) == -1) {
															directSources.push(objEl.file)
															streams.push({
																name: objEl.file.includes('redirector.googlevideo.com') ? 'Google Video' : 'Standard Server',
																title: objEl.label,
																url: proxy.addProxy(objEl.file, { headers: { referer: nextIframe, origin: 'https://k-vid.net' } })
															})
														}
													})
											})
											if ($('li.linkserver').length) {
												const parallelObj = {}
												$('li.linkserver').each((ij, el) => {
													let videoUrl = $(el).attr('data-video')
													if (videoUrl) {
														if (videoUrl.startsWith('//'))
															videoUrl = 'https:' + videoUrl
														const task = { name: $(el).text().trim(), title: 'External URL', externalUrl: videoUrl }
														// xstreamcdn, kvid, rapidvideo, mp4upload, openload, streamango
														parallelObj[videoUrl] = cb => {
															const extract = async () => {
																const scraped = await scrape({ url: task.externalUrl })
																if ((scraped || {}).url && !scraped.external) {
																	task.url = scraped.url
																	delete task.externalUrl
																	task.title = scraped.resolution || 'Stream'
																	streams.push(task)
																} else
																	streams.push(task)
																cb()
															}
															extract()
														}
													}
												})
												async.parallel(parallelObj, (err, results) => {
													if (streams.length)
														resolve({ streams })
													else
														reject(defaults.name + ' - Did not find any videos for request')
												})
											} else
												resolve({ streams })
										} else
											reject(defaults.name + ' - Unexpected second iframe response')
									})
						    	else {
						    		reject(defaults.name + ' - Could not get second iframe url')
						    	}
						    })
						} else
							reject(defaults.name + ' - Unexpected video page response body')
					} else {
						reject(defaults.name + ' - Unexpected video response')
					}
				})
	        } else {
	        	reject(defaults.name + ' - Unable to get details on episode for url: ' + args.id.replace(defaults.prefix, ''))
	        }
	    })
	})

	builder.defineSubtitlesHandler(args => {
		return new Promise((resolve, reject) => {
			resolve({ subtitles: subtitles[args.id] || [] })
		})
	})

	const addonInterface = getInterface(builder)

	return getRouter(addonInterface)

}

module.exports = retrieveRouter()
