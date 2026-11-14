# 大体积图片内存峰值测试

本样本引用由 `tools/make-perf-images.ps1` 按固定随机种子生成的 5–10 MiB PNG 图片，覆盖独立块级图片与行内混排图片两种解码路径。

## 块级大图 1

![大图 1](./large-image-001.png)

## 块级大图 2

![大图 2](./large-image-002.png)

## 块级大图 3

![大图 3](./large-image-003.png)

## 块级大图 4

![大图 4](./large-image-004.png)

## 行内混排大图

前置文字 ![大图 5](./large-image-005.png) 中间文字 ![大图 6](./large-image-006.png) 尾部文字。
