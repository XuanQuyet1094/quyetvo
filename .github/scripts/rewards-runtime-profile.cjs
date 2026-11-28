'use strict';
const modes=['morning','retry','reconcile'];
function apply(cfg,mode){
 if(!modes.includes(mode))return cfg;
 cfg.accountDelay={min:'15sec',max:'30sec'};
 cfg.taskDelay={min:'10sec',max:'15sec'};
 cfg.searchSettings||={};
 cfg.searchSettings.searchDelay={min:'30sec',max:'40sec'};
 cfg.searchSettings.readDelay={min:'30sec',max:'40sec'};
 return cfg;
}
function restRange(mode){return modes.includes(mode)?[15,31]:[100,181];}
module.exports={apply,restRange};

