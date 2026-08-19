## 组件里有this对象时，builder作为参数应正确传递this作用域


```ts
@Component
struct Test{
  // ...
  build(){
    Comp({
      // btnBuilder:this.btnBuilder  反例
      btnBuilder: ()=> this.btnBuilder() // 正例
    })
  }

  @Builder
  btnBuilder(){
    Button('click').onclick(()=>{
      this.info.check()
    })
  }
}
```



## 组件里涉及到路由管理的子页面根组件必须是NavDestination

判定标准：当前组件包的module.json5中包含"routerMap"配置项，配置文件中包含当前文件，则当前组件build()方法中的根组件必须为NavDestination

判定链路：

1. 当前组件包Component/src/main/module.json5中存在路由表

```json
{
  "module": {
    // ...
    "routerMap": "$profile:route_map"
  }
}

```

2. 当前组件包Component/src/main/resources/base/profile/route_map.json路由表文件中涉及当前页面

```json
{
  "routerMap": [
    {
      "name": "SubPage",
      "pageSourceFile": "src/main/ets/views/SubPage.ets",
      "buildFunction": "buildSubPage"
    }
  ]
}
```

3. 当前页面必须使用NavDestination，否则判定为路由跳转异常

```ts
@Builder
export function buildSubPage(){
  SubPage()
}

@ComponentV2
struct SubPage(){
  build(){
    NavDestination(){
      // ...
    }
  }
}
```

### 不支持一个组件上挂载多个bindsheet

```ts
// 反例：
@ComponentV2
struct Comp(){
  build(){
    Column(){

    }
    .bindSheet()
    .bindSheet()
  }
}
```
