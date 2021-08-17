/**                                                                          
 *  rate-limiter-flexible was chosen for the following reasons:              
 *                                                                           
 *  1.  It supports redis but also allows you to use a built in              
 *      memory store (this makes it easy to deploy the server                
 *      to AWS and chose to use Elasticache redis while allowing             
 *      simple local development without having to stand up a                
 *      redis server / cluster).  Also allows the use of PM2 (our            
 *      current process manager in AWS as well--see:                         
 *      https://github.com/animir/node-rate-limiter-flexible/wiki/PM2-cluster
 *      )                                                                    
 *                                                                           
 *  2.  It's performant and robust (see papers on the git page under         
 *      advantages):                                                         
 *        - https://github.com/animir/node-rate-limiter-flexible#readme      
 *                                                                           
 *  3.  It has fallbacks in the event of failures of redis stores            
 *                                                                           
 *  4.  It has configureation flexibility (i.e. limits for different         
 *      users, ips etc.)                                                     
 *        - see the copy/paste examples on this wiki:                        
 *          https://github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#authorized-and-not-authorized-users
 *                                                                           
 *  5.  It doesn't have npm audit failures like Brute or others due to       
 *      race conditions.                                                     
 *                                                                           
 *  This middleware code adapted from example here:                          
 *    - https://github.com/animir/node-rate-limiter-flexible/wiki/Express-Middleware
 *                                                                           
 */                           
import * as ds from './../utils/debugScopes'
 const log = ds.getLog('rateLimitMem')
                                                                              
 const { RateLimiterMemory } = require('rate-limiter-flexible')               
 
 // HTTP Status Codes:
 const TOO_MANY_REQUESTS = 429
          
 const rateLimiter = new RateLimiterMemory({                                  
   keyPrefix: 'middleware',
   points: 34,   // 34 requests
   duration: 60   // per minute  (2040 per hour per IP address)               
 })

// Debug test:  8 / 5 minutes                                                
// const rateLimiter = new RateLimiterMemory({                               
//   keyPrefix: 'middleware',
//   points: 8,                                                              
//   duration: 5*60
// })

// Middleware function:                                                      
const rateLimitMem = (req:any, res:any, next:any) => {                                   
  const ip = req.clientIp                                                    
  rateLimiter.consume(ip)   // clientIp comes from request-ip middleware.    
    .then(() => {
      next()
    })
    .catch(() => {
      log.warn(`Rate limiting ip address: "${ip}"`)
      res.status(TOO_MANY_REQUESTS).send('Too Many Requests')
    })
}

module.exports = rateLimitMem