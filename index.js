var async = require('async');
var rp = require('request-promise');
var Promise = require('bluebird');

//SET UP CACHE
var redis = require('redis');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

/*
  LoL API object that deals with everything.
*/
var LoLAPI = {
  init: function(inputObj) {
    /*
      SET UP CACHE TODO: replace with CHECK that global redis exists
    */
    this.cache = inputObj.cache;
    this.cache.on("error", function (err) {
      this.errorHandle(err);
    }.bind(this));
    /*
      END CACHE SETUP
    */

    /*
      SET UP LOGGER
    */
    if(typeof inputObj.logger !== 'undefined') {
      this.logger = inputObj.logger;
    }
    else {
      this.logger = console.log;
    }
    /*
      END SET UP LOGGER
    */

    /*
      SET UP ERROR HANDLER
    */
    if(typeof inputObj.errorHandler !== 'undefined') {
      this.errorHandler = inputObj.errorHandler;
    }
    else {
      this.errorHandler = console.log;
    }
    /*
      END ERROR HANDLER
    */


    this.setApiKey(inputObj.api_key);
    this.failCount = inputObj.fail_count || 5;
    //Load all the handlers in the handlers dir.
    require('fs').readdirSync(__dirname + '/lib/handlers').forEach(function(file) {
      if (file.match(/\.js$/) !== null && file !== 'index.js') {
        var r = require('./lib/handlers/' + file);
        this.request[r.name] = r.handler.bind(this);
      }
    }.bind(this));
    //TODO: do we definitely want -1?
    this.setRateLimit(inputObj.limit_ten_seconds-1, inputObj.limit_one_hour);
    //Set the timeouts for the queue master
    this.queueInterval = setInterval(function() {
      return this.checkRateLimit()
        .then((spaces)=> {
          if(spaces && (this.queue.length > 0)) {
            return this.execQueue(spaces);
          }
          else {
            return;
          }
        }).bind(this);
    }.bind(this), 10);
    console.log('Created LoL API Request Handler');
    return this;
  },
  setApiKey: function(key) {
    return this.apiKey = key;
  },
  refreshCache: function() {
    return this.cache.delAsync('lolapi_tenseconds', 'lolapi_onehour');
  },
  incrementTenSecondsCount: function() {
    //If not set then set
    return this.cache.multi().incr('lolapi_tenseconds').expire('lolapi_tenseconds', 11).execAsync()
    .then((value)=> {
      if(!value) {
        return this.logger("Couldn't set the 10 second rate key");
      }
      return value;
    }).bind(this);
  },
  incrementOneHourCount: function() {
    //If not set then set
    return this.cache.multi().incr('lolapi_onehour').expire('lolapi_onehour', 3601).execAsync()
    .then((value)=> {
      if(!value) {
        return this.logger("Couldn't set one hour key.");
      }
      return value;
    }).bind(this);
  },
  getTenSecondsCount: function() {
    return this.cache.getAsync('lolapi_tenseconds')
      .then((key)=> {
        if(key) {
          return key;
        }
        else {
          return 0;
        }
      });
  },
  getOneHourCount: function() {
    return this.cache.getAsync('lolapi_onehour')
    .then((key)=> {
      if(key) {
        return key;
      }
      else {
        return 0;
      }
    });

  },
  rateLimit: {
    tenSeconds: null,
    oneHour: null,
  },
  requestCount: {
    tenSeconds: 0,
    oneHour: 0,
    outstandingRequests: 0
  },
  failCount: 5,
  setRateLimit: function(ten_seconds, one_hour) {
    this.rateLimit.tenSeconds = ten_seconds;
    this.rateLimit.oneHour = one_hour;
  },
  // If a 429 is discovered then it sends a retry-after seconds count, test if it greater than remaining time
  retryRateLimitOverride: function(retry_after) {
    //TODO: do I need to parse int here?
    var r = parseInt(retry_after) * 1000;
    //Always clear the 10s timeout just to be certain.
    //Clear interval and reset after retry after is cleared
    clearInterval(this.tenSecondsTimeout);
    console.log(this.tenSecondsTimeout);
  },
  checkRateLimit: function() {
    return this.getOneHourCount() //Get this first because we care about it less
      .then((oneHour)=> {
        return this.getTenSecondsCount()
        .then((tenSeconds)=> { //NESTED SO WE CAN ACCESS UPPER VARS IN SCOPE
          //TODO: there is a wierd type error here........ for some reason it outputs number for tenseconds and a string for hour
          if((parseInt(tenSeconds) + this.requestCount.outstandingRequests) >= this.rateLimit.tenSeconds) {
            return 0;
          }
          else if((parseInt(oneHour) + this.requestCount.outstandingRequests) >= this.rateLimit.oneHour) {
            console.log('Hit hour limit: ' + oneHour);
            return 0;
          }
          else {
            //return the smaller of the requests available
            var requests_left_hour = this.rateLimit.oneHour - parseInt(oneHour) - this.requestCount.outstandingRequests;
            var requests_left_ten_seconds = this.rateLimit.tenSeconds - parseInt(tenSeconds) - this.requestCount.outstandingRequests;
            //As we dont' need to worry about race conditions we don't have to recheck if positive
            if(requests_left_hour > requests_left_ten_seconds) {
              if(requests_left_ten_seconds > 0) {
                return requests_left_ten_seconds;
              }
              else {
                return 0;
              }
            }
            else {
              if(requests_left_hour > 0) {
                return requests_left_hour;
              }
              else {
                return 0;
              }
            }
          }
        });
      });

  },
  initRequest: function(endpoint, returnVars) {
    //Add the request and set up as a promise
    var cb = function(endpoint, returnVars, times_failed) {
      return this.incrementOneHourCount()
        .then((oneHour)=> {
          return this.incrementTenSecondsCount()
            .then((tenSeconds)=> {
              this.requestCount.outstandingRequests += 1;
              var options = {
                uri: encodeURI(endpoint + '&api_key=' + this.apiKey), //Assume the ? has already been added by our endpoint
                json: true,
                resolveWithFullResponse: true
              }
              console.log('Using ' + options.uri);
              console.log(this.requestCount.outstandingRequests);
              console.log(tenSeconds + ' ' + oneHour);
              return rp(options)
              .then(
                function(response) {
                  this.requestCount.outstandingRequests -= 1;
                  if(returnVars) {
                    if(typeof returnVars === 'string') {
                      return response.body[returnVars]; //Resolve promise
                    }
                    else {
                      var tmp = {};
                      returnVars.forEach(function(item, i) {
                        if(response[item]) {
                          tmp[item] = response.body[item];
                        }
                        else {
                          this.errorHandle("Couldn't locate the requested var");
                        }
                      }.bind(this));
                      return tmp;  //Resolve promise
                    }
                  }
                  else {
                    console.log('SUCCESSFUL RESPONSE FROM: ' + endpoint);
                    return response.body; //Resolve promise
                  }
                }.bind(this),
                //REJECTION
                function(reason) {
                  this.requestCount.outstandingRequests -= 1;
                  if(reason.statusCode === 429) {
                    console.log('Rate limit reached!')
                    //NOTE: Riot have been known to remove the header so including this to avoid breaking.
                    if(typeof reason.response['headers']['retry-after'] !== 'undefined') {
                      console.log('Retrying after ' + reason.response['headers']['retry-after'] + 's');
                      // this.retryRateLimitOverride(reason.response['headers']['retry-after']);
                    }
                    else {
                      console.log('No Retry-After header');
                      console.log(reason.response['headers']);
                    }
                  }
                  if(typeof times_failed !== 'number') {
                    times_failed = 1;
                  }
                  else {
                    times_failed++;
                  }
                  this.errorHandle('Request ' + endpoint + ' REJECTED with reason: ' + reason + '. Adding back to queue. Failed ' + times_failed + ' times.');
                  return this.addToQueue(cb.bind(this, endpoint, returnVars, times_failed), times_failed, endpoint);
                }.bind(this));
            }); //NOTE: I'm not sure why we can't bind here but if we do it causes times_failed to not increment
        });
    }
    return this.addToQueue(cb.bind(this, endpoint, returnVars), 0, endpoint);
  },
  addToQueue: function(fn, times_failed, endpoint) {
    if(times_failed > this.failCount) {
      return this.errorHandle('Request from endpoint "' + endpoint + '" exceeded fail count!');
    }
    else {
      //Turns function to deferred promise and adds to queue.
      console.log('Adding ' + endpoint + ' to queue.');
      var resolve, reject;
      var promise = new Promise(function(reso, reje) {
        resolve = reso;
        reject = reje;
      })
      .then(function(times_failed) {
        console.log('Executing queue item!');
        return fn(); //NOTE: fn is prebound with arguments
      });
      this.queue.push({
        resolve: resolve,
        reject: reject,
        promise: promise
      });
      return promise;
    }
  },
  execQueue: function(end_index) {
    while(this.queue.length > 0 && end_index > 0) {
      bUnloaded = true;
      var w = this.queue.shift();
      w.resolve();
      end_index--;
    }
    if(bUnloaded) {
      console.log(this.queue.length + ' in queue after unloading.');
    }
    return;
  },
  queue: [],
  request: {}, //contains all the handlers. Created in the INIT function above.
  replaceEndpointVariables: function(realm, endpoint, platform) { //Replaces $r and $p with platform and realm
    //Realm matches $r
    endpoint = endpoint.replace(/\$r/g, realm);
    if(platform) {
      endpoint = endpoint.replace(/\$p/g, platform);
    }
    return endpoint;
  },
  errorHandle: function(str) {
    this.errorHandler(str);
  }
}

module.exports = LoLAPI;
