manifest.txt: Main-Class: UcidMonitorService
Class-Path: lib/ecsjtapia.jar lib/log4j-api-2.17.3-snapshot.jar lib/log4j-core-2.17.3-snapshot.jar lib/servlet-api-2.5-6.1.1.jar

to build jar:
 javac -cp "lib/*" -d out src\*.java
 jar cfm UCID.jar manifest.txt -C out 

to run: java -jar UCID.jar